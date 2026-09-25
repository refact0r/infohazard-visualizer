import { join } from 'node:path';

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void };

// JSON-lines RPC to a persistent osascript (JXA) process. Commands run strictly in order,
// so time-critical work (reveals) gets its own Bridge instead of queueing behind page loads.
export class Bridge {
  private proc: ReturnType<typeof Bun.spawn>;
  private nextId = 1;
  private pending = new Map<number, Pending>();

  constructor(public name: string) {
    this.proc = Bun.spawn(['osascript', '-l', 'JavaScript', join(import.meta.dir, 'bridge.jxa.js')], {
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'inherit',
    });
    this.readLoop();
  }

  private async readLoop() {
    const decoder = new TextDecoder();
    let buf = '';
    for await (const chunk of this.proc.stdout as ReadableStream<Uint8Array>) {
      buf += decoder.decode(chunk, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        const msg = JSON.parse(line);
        const p = this.pending.get(msg.id);
        if (!p) continue;
        this.pending.delete(msg.id);
        if (msg.ok) p.resolve(msg.result);
        else p.reject(new Error(`[${this.name}] ${msg.error}`));
      }
    }
    for (const p of this.pending.values()) p.reject(new Error(`[${this.name}] bridge exited`));
    this.pending.clear();
  }

  call<T = any>(cmd: string, args?: object): Promise<T> {
    const id = this.nextId++;
    // ASCII-only so a multi-byte character can never be split across two stdin reads in JXA
    const line =
      JSON.stringify({ id, cmd, args }).replace(
        /[\u007f-\uffff]/g,
        (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'),
      ) + '\n';
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      const stdin = this.proc.stdin as import('bun').FileSink;
      stdin.write(line);
      stdin.flush();
    });
  }

  close() {
    try {
      (this.proc.stdin as import('bun').FileSink).end();
    } catch {}
    this.proc.kill();
  }
}
