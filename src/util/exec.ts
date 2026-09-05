import { execFile } from "node:child_process"
import { promisify } from "node:util"

const exec = promisify(execFile)

export interface ExecResult {
  stdout: string
  stderr: string
}

export async function run(
  cmd: string,
  args: string[],
  opts?: { cwd?: string; timeoutMs?: number; env?: Record<string, string> },
): Promise<ExecResult> {
  const { stdout, stderr } = await exec(cmd, args, {
    cwd: opts?.cwd,
    timeout: opts?.timeoutMs ?? 120_000,
    maxBuffer: 32 * 1024 * 1024,
    env: opts?.env ? { ...process.env, ...opts.env } : process.env,
  })
  return { stdout: stdout.toString(), stderr: stderr.toString() }
}

/** Run and fail loudly with stderr context — for git/gh where exit codes matter. */
export async function mustRun(
  what: string,
  cmd: string,
  args: string[],
  opts?: { cwd?: string; timeoutMs?: number },
): Promise<ExecResult> {
  try {
    return await run(cmd, args, opts)
  } catch (err) {
    const e = err as { stderr?: string; stdout?: string; message?: string }
    const detail = (e.stderr || e.stdout || e.message || "").trim()
    throw new Error(`${what} failed: ${detail.slice(0, 2000)}`)
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
