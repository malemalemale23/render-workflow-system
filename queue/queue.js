import { Queue } from "bullmq";
import IORedis from "ioredis";

export const workflowQueue = new Queue("workflow", {
  connection: new IORedis(process.env.REDIS_URL)
});