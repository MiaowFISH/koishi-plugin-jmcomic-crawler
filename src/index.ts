import { Context, Schema } from "koishi";

export const name = "jmcomic-crawler";
export const usage = `又一个JM本子下载插件`;

export interface Config {}

export const Config: Schema<Config> = Schema.object({
  endpoint: Schema.string()
    .default("http://127.0.0.1:7210")
    .description("后端API地址"),
  queryInterval: Schema.number()
    .min(1)
    .default(500)
    .description("任务查询间隔(ms)"),
  encrypt: Schema.boolean().default(true).description("是否强制启用加密"),
  password: Schema.string().description("默认密码"),
  timeout: Schema.number()
    .min(1)
    .default(30000)
    .description("任务超时时间(ms)"),
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

// 队列管理器
// 每个频道只能进行一个任务
// 后续任务进入队列，顺序执行
class QueueManager {
  private queue: Task[] = [];
  private currentTask: Task | null = null;
}

// 任务管理器
// 轮询任务状态
class TaskManager {
  private tasks: Task[] = [];
}

export function apply(ctx: Context) {
  const cmd = ctx
    .command("jm", "")
    .option("password", "-p <password:string> 密码")
    .option("no-encrypt", "-n 不加密")
    .option("pdf", "-f pdf 输出pdf")
    .option("zip", "-f zip 输出zip")
    .option("quality", "-q <quality:number> 图片质量")
    .action(async ({ session, options }, id) => {
      if (!id) {
        return "请输入本子ID";
      }
      const submit: Submit = {
        album_id: id,
        password: options.password,
        encrypt: !options["no-encrypt"],
        output_format: options.pdf ? "pdf" : "zip",
        quality: options.quality,
      };

      const { cid, channelId } = session
      // 获取当前频道任务，将任务加入队列
      // 显示排队状态
      // const ids = await session.send("当前队列: ");
      // 记录消息id，文件发送后一并撤回
      //



      const resp: Task = await ctx.http.post(`${ctx.config.endpoint}/task`, submit);


      let status: string;
      // 轮询任务状态
      const interval = setInterval(async () => {
        const task: Task = await ctx.http.get(`${ctx.config.endpoint}/task/${resp.task_id}`);
        if (status !== task.status) {
          status = task.status;
          // 更新消息
          // await session.send(`状态: ${task.status}`);
          // 需要记录消息ID，撤回上一条状态消息
          // await session.bot.deleteMessage(channelId, messageId);
        }
        if (task.status === "done") {
          clearInterval(interval);
          // 发送文件
          // await session.send("下载完成");
          // await session.send(h.file(task.download_url));
          // 标记任务完成，移除队列
        }
      }, ctx.config.queryInterval);
    });

  const tasks = cmd.subcommand("tasks", "下载任务管理", { authority: 3 });

  tasks
    .subcommand("list", "", { authority: 3 })
    .action(async ({ session }) => {

    });
}
