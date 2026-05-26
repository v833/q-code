/**
 * CLI 启动副作用：在 `index.ts` 最早 import 时根据 argv 设置 `NO_COLOR` / `FORCE_COLOR`。
 */
import { applyNoColorEnvironment } from './color-env';

applyNoColorEnvironment();
