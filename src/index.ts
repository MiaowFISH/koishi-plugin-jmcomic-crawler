import { Context, Schema, h, Logger, Session, sleep } from "koishi";

export const name = "jmcomic-crawler";
export const usage = "又一个JM本子下载插件";

export interface Config {
  endpoint: string;
  queryInterval: number;
  encrypt: boolean;
  password?: string;
  timeout: number;
}

export const Config: Schema<Config> = Schema.object({
  endpoint: Schema.string().default("http://127.0.0.1:7210").description("后端API地址"),
  queryInterval: Schema.number().min(1).default(500).description("任务查询间隔(ms)"),
  encrypt: Schema.boolean().default(true).description("是否强制启用加密"),
  password: Schema.string().description("默认密码"),
  autoDrawback: Schema.boolean().default(true).description("是否自动撤回状态消息"),
  timeout: Schema.number().min(1).default(30000).description("任务超时时间(ms)"),
});

interface Submit {
  album_id: string;
  password?: string;
  encrypt?: boolean;
  output_format?: "zip" | "pdf";
  quality?: number;
}

interface Task {
  task_id: string;
  album_id: string;
  status: string;
  progress: number;
  total_images: number;
  stage: string;
  duplicate: boolean;
  metadata: {
    cache_hash: string;
    output_format: string;
    quality: number;
    encrypt: boolean;
    compression: number;
    proxy: string;
  };
  download_url: string;
  artifact_filename: string;
  error: string;
  password: string;
}

type StatusMessageId = string | string[] | undefined;

interface QueueJob {
  id: string;
  channelCid: string;
  submit: Submit;
  session: Session;
  enqueuedAt: number;
  controller: AbortController;
  statusMsg?: StatusMessageId;
  lastStatus?: string;
  backendTask?: Task;
}

class QueueManager {
  private queues = new Map<string, QueueJob[]>();
  private running = new Set<string>();
  private logger: Logger;

  constructor(
    private ctx: Context,
    private config: Config,
  ) {
    this.logger = new Logger(name);
  }

  public enqueue(job: QueueJob): number {
    const q = this.queues.get(job.channelCid) ?? [];
    q.push(job);
    this.queues.set(job.channelCid, q);
    this.maybeStart(job.channelCid);
    return q.length;
  }

  public getSummary() {
    const result: Record<
      string,
      { running: boolean; length: number; items: { id: string; album_id: string; state: "running" | "waiting" }[] }
    > = {};
    for (const [cid, q] of this.queues.entries()) {
      const running = this.running.has(cid);
      result[cid] = {
        running,
        length: q.length,
        items: q.map((job, idx) => ({
          id: job.id,
          album_id: job.submit.album_id,
          state: idx === 0 && running ? "running" : "waiting",
        })),
      };
    }
    return result;
  }

  public async cancel(channelCid: string, localJobId: string): Promise<boolean> {
    const q = this.queues.get(channelCid);
    if (!q || q.length === 0) return false;
    const idx = q.findIndex((j) => j.id === localJobId);
    if (idx === -1) return false;
    const [job] = q.splice(idx, 1);
    try {
      job.controller.abort();
    } catch {}
    if (q.length === 0) this.queues.delete(channelCid);
    return true;
  }

  public async clear(channelCid: string): Promise<number> {
    const q = this.queues.get(channelCid);
    if (!q) return 0;
    const count = q.length;
    for (const job of q) {
      try {
        job.controller.abort();
      } catch {}
    }
    this.queues.delete(channelCid);
    this.running.delete(channelCid);
    return count;
  }

  private async maybeStart(cid: string) {
    if (this.running.has(cid)) return;
    const q = this.queues.get(cid);
    if (!q || q.length === 0) return;
    this.running.add(cid);
    try {
      while (q.length) {
        const job = q[0];
        try {
          await this.processJob(job);
        } catch (e) {
          this.logger.warn(e);
        } finally {
          q.shift();
        }
      }
    } finally {
      this.running.delete(cid);
      if (!q || q.length === 0) this.queues.delete(cid);
    }
  }

  private async processJob(job: QueueJob) {
    const { session, submit } = job;
    const channelId = session.channelId as string;
    // 进入运行阶段提示
    job.statusMsg = await safeSend(session, `开始下载 [${submit.album_id}]，正在创建任务...`);

    // 补全参数：强制加密与默认密码
    const finalSubmit: Submit = {
      ...submit,
      encrypt: this.config.encrypt ? true : submit.encrypt,
      password: submit.password ?? this.config.password,
      output_format: submit.output_format ?? "zip",
    };

    // 创建后端任务
    let created: Task;
    try {
      created = await this.ctx.http.post(`${this.config.endpoint}/tasks`, finalSubmit, {
        timeout: this.config.timeout,
      });
      job.backendTask = created;
    } catch (err) {
      await this.updateStatus(session, job, `创建任务失败：${formatErr(err)}`);
      return;
    }

    await this.updateStatus(
      session,
      job,
      `任务已创建：${created.task_id}，开始下载（共${created.total_images || "?"}张）`,
    );

    // 轮询
    const startAt = Date.now();
    let lastStatus = "";
    while (true) {
      // 检查取消或超时
      if (job.controller.signal.aborted) {
        await this.updateStatus(session, job, "任务已取消");
        break;
      }
      if (Date.now() - startAt > this.config.timeout) {
        await this.updateStatus(session, job, "任务超时");
        break;
      }
      let task: Task;
      try {
        task = await this.ctx.http.get(`${this.config.endpoint}/tasks/${created.task_id}`, {
          timeout: this.config.timeout,
        });
      } catch (e) {
        await this.updateStatus(session, job, `查询失败，重试中...`);
        await sleep(this.config.queryInterval);
        continue;
      }

      job.backendTask = task;
      // if (task.status !== lastStatus) {
      //   lastStatus = task.status;
      //   const progressText = task.total_images ? `${task.progress}/${task.total_images}` : `${task.progress}`;
      //   await this.updateStatus(
      //     session,
      //     job,
      //     `状态：${task.status} · 阶段：${task.stage ?? "-"} · 进度：${progressText}`,
      //   );
      // }

      if (task.status === "done") {
        await this.updateStatus(session, job, "打包完成，开始发送文件...");
        try {
          if (task.download_url) {
            // 发送文件或链接
            const filename = task.artifact_filename || undefined;
            const download_url = this.config.endpoint + task.download_url;
            const seg = filename ? h.file(download_url, { filename }) : h.file(download_url);
            await session.send(seg);
          } else {
            await session.send(`下载地址：${task.download_url}`);
          }
        } catch (e) {
          await session.send(`发送文件失败：${formatErr(e)} · 下载地址：${task.download_url}`);
        }
        // 收尾
        await this.recallStatus(session, job);
        await safeSend(session, `完成 [${submit.album_id}] | 密码：${task.password || "无"}`);
        break;
      }

      if (task.status === "error" || task.error) {
        await this.updateStatus(session, job, `任务失败：${task.error || "未知错误"}`);
        break;
      }

      await sleep(this.config.queryInterval);
    }
  }

  private async updateStatus(session: Session, job: QueueJob, text: string) {
    await this.recallStatus(session, job);
    job.statusMsg = await safeSend(session, text);
    job.lastStatus = text;
  }

  private async recallStatus(session: Session, job: QueueJob) {
    const id = job.statusMsg;
    if (!id) return;
    try {
      if (Array.isArray(id)) {
        for (const mid of id) {
          await session.bot?.deleteMessage(session.channelId as string, mid);
        }
      } else {
        await session.bot?.deleteMessage(session.channelId as string, id);
      }
    } catch {}
    job.statusMsg = undefined;
  }
}

function formatErr(e: any): string {
  if (!e) return "未知错误";
  if (typeof e === "string") return e;
  if (e.message) return e.message;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}

async function safeSend(session: Session, content: any): Promise<StatusMessageId> {
  try {
    return await session.send(content as any);
  } catch {
    return undefined;
  }
}

let jobCounter = 0;

export function apply(ctx: Context, config: Config) {
  const queue = new QueueManager(ctx, config);

  const cmd = ctx
    .command("jm <id:string>", "下载JM本子")
    .option("password", "-p <password:string> 密码")
    .option("no-encrypt", "-n 不加密")
    .option("pdf", "--pdf 输出pdf")
    .option("zip", "--zip 输出zip")
    .option("quality", "-q <quality:number> 图片质量")
    .action(async ({ session, options }, id) => {
      if (!id) return "请输入本子ID";
      const submit: Submit = {
        album_id: id,
        password: options.password ?? config.password,
        encrypt: config.encrypt ? true : !options["no-encrypt"],
        output_format: options.pdf ? "pdf" : "zip",
        quality: options.quality,
      };

      const channelCid = session.cid;
      const job: QueueJob = {
        id: `J${++jobCounter}`,
        channelCid,
        submit,
        session,
        enqueuedAt: Date.now(),
        controller: new AbortController(),
      };
      const pos = queue.enqueue(job);
      await safeSend(session, `已加入队列（位置 ${pos}）[${submit.album_id}]`);
    });

  const tasks = cmd.subcommand(".tasks", "下载任务管理", { authority: 3 });

  tasks
    .subcommand(".list", "列出所有任务")
    .option("all", "-a 显示所有频道")
    .action(async ({ session, options }) => {
      const summary = queue.getSummary();
      const lines: string[] = [];
      const selfCid = session.cid;
      for (const [cid, s] of Object.entries(summary)) {
        if (!options.all && cid !== selfCid) continue;
        lines.push(`频道 ${cid} · 运行中: ${s.running ? "是" : "否"} · 队列: ${s.length}`);
        for (const it of s.items) {
          lines.push(`  - ${it.state === "running" ? "▶" : "…"} ${it.id} #${it.album_id}`);
        }
      }
      return lines.length ? lines.join("\n") : "暂无任务。";
    });

  tasks.subcommand(".cancel <jobId:string>", "取消指定任务").action(async ({ session }, jobId) => {
    if (!jobId) return "请提供任务ID";
    const ok = await queue.cancel(session.cid, jobId);
    return ok ? `已取消 ${jobId}` : `未找到任务 ${jobId}`;
  });

  tasks.subcommand(".clear", "清空当前频道任务队列").action(async ({ session }) => {
    const n = await queue.clear(session.cid);
    return `已清空 ${n} 个任务`;
  });
}
