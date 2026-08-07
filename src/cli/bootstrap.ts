/**
 * q-code 薄启动入口：只静态加载颜色环境、argv/版本/help 与轻量诊断，
 * 早期命令在重运行时依赖加载前退出，其余路径按需动态 import。
 */
import '../runtime/color-bootstrap';
import {
  formatCliHelp,
  formatCliVersion,
  getEarlyCliCommand,
  getPackageVersion,
} from '../runtime/cli-info';
import {
  createStartupTrace,
  isStartupTraceEnabled,
} from '../runtime/startup-trace';

/** CLI 进程入口。 */
export async function bootstrap(argv: string[] = process.argv.slice(2)): Promise<number> {
  const startupTrace = createStartupTrace({
    enabled: isStartupTraceEnabled(argv),
  });
  startupTrace.mark('bootstrap');

  const packageVersion = getPackageVersion();
  const earlyCliCommand = getEarlyCliCommand(argv);

  if (earlyCliCommand === 'version') {
    console.log(formatCliVersion(packageVersion));
    startupTrace.mark('version');
    startupTrace.print();
    return 0;
  }

  if (earlyCliCommand === 'help') {
    console.log(formatCliHelp(packageVersion));
    startupTrace.mark('help');
    startupTrace.print();
    return 0;
  }

  if (earlyCliCommand === 'exec') {
    startupTrace.mark('exec-import-start');
    const { runExecCli } = await import('./exec-cli');
    startupTrace.mark('exec-import');
    const code = await runExecCli({
      argv: argv.slice(1),
      packageVersion,
      startupTrace,
      applyRuntimeConfig: () => applyRuntimeConfigForStartup(startupTrace),
    });
    startupTrace.mark('exec');
    startupTrace.print();
    return code;
  }

  if (earlyCliCommand === 'acp') {
    startupTrace.mark('acp-import-start');
    const { runAcpCli } = await import('./acp-cli');
    startupTrace.mark('acp-import');
    const code = await runAcpCli({
      argv: argv.slice(1),
      packageVersion,
      startupTrace,
      applyRuntimeConfig: () => applyRuntimeConfigForStartup(startupTrace),
    });
    startupTrace.mark('acp');
    startupTrace.print();
    return code;
  }

  if (earlyCliCommand === 'update') {
    startupTrace.mark('update-import-start');
    const { runCliUpdate } = await import('../runtime/update');
    startupTrace.mark('update-import');
    const code = await runCliUpdate({ currentVersion: packageVersion, argv });
    startupTrace.mark('update');
    startupTrace.print();
    return code;
  }

  if (earlyCliCommand === 'audit') {
    await applyRuntimeConfigForStartup(startupTrace);
    startupTrace.mark('audit-import-start');
    const { runAuditCli } = await import('../observability/audit-cli');
    startupTrace.mark('audit-import');
    const code = await runAuditCli(argv.slice(1));
    startupTrace.mark('audit');
    startupTrace.print();
    return code;
  }

  if (earlyCliCommand === 'init') {
    startupTrace.mark('init-import-start');
    const { runInitCli } = await import('../runtime/init-cli');
    startupTrace.mark('init-import');
    const code = await runInitCli({ argv: argv.slice(1), cwd: process.cwd() });
    startupTrace.mark('init');
    startupTrace.print();
    return code;
  }

  if (earlyCliCommand === 'eval') {
    await applyRuntimeConfigForStartup(startupTrace);
    startupTrace.mark('eval-import-start');
    const { runEvalCli } = await import('../evals');
    startupTrace.mark('eval-import');
    const code = await runEvalCli(argv.slice(1));
    startupTrace.mark('eval');
    startupTrace.print();
    return code;
  }

  if (earlyCliCommand === 'dashboard') {
    await applyRuntimeConfigForStartup(startupTrace);
    startupTrace.mark('dashboard-import-start');
    const { runDashboardCli } = await import('../dashboard');
    startupTrace.mark('dashboard-import');
    const code = await runDashboardCli(argv.slice(1));
    startupTrace.mark('dashboard');
    startupTrace.print();
    return code;
  }

  await applyRuntimeConfigForStartup(startupTrace);
  startupTrace.mark('main-import-start');
  const { runMain } = await import('./main');
  startupTrace.mark('main-import');
  await runMain({ packageVersion, argv, startupTrace });
  startupTrace.mark('main');
  startupTrace.print();
  return 0;
}

async function applyRuntimeConfigForStartup(
  startupTrace: ReturnType<typeof createStartupTrace>,
): Promise<void> {
  startupTrace.mark('runtime-config-import-start');
  const { applyRuntimeConfig } = await import('../config/runtime-config');
  startupTrace.mark('runtime-config-import');
  applyRuntimeConfig();
  startupTrace.mark('runtime-config');
}

bootstrap().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  }
);
