import { runWorker } from "./lib/batch.ts";

type IntervalEvent = {
  lastRunAt?: Date;
};

export default async function (_interval: IntervalEvent) {
  const result = await runWorker();
  console.log(result);
  return result;
}
