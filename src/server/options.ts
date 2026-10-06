export function parseDashboardArgs(argv: string[], env: NodeJS.ProcessEnv = process.env) {
  let port = Number(env.ALGORITHM_DX_DASHBOARD_PORT ?? 8787);
  let dbPath = env.ALGORITHM_DX_DB_PATH ?? 'data/algorithm-dx.sqlite';
  let open = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--port') port = Number(argv[++i]);
    else if (arg === '--db') dbPath = argv[++i] ?? '';
    else if (arg === '--open') open = true;
    else throw new Error(`未知参数：${arg}`);
  }
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error(`端口不合法：${port}`);
  if (!dbPath.trim() || dbPath.startsWith('--')) throw new Error('--db 缺少路径');
  return { port, dbPath, open };
}
