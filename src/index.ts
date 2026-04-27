import { startApp } from "./app";

startApp().catch((error) => {
  console.error("启动失败:", error);
  process.exitCode = 1;
});
