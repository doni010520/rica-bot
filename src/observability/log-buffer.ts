/**
 * src/observability/log-buffer.ts
 *
 * Ring buffer em memória dos últimos N logs.
 * Exposto via GET /admin/logs pra debug sem precisar acessar o EasyPanel.
 *
 * Baseado no fp-solar-agent.
 */

const MAX_ENTRIES = 2000

class LogRingBuffer {
  private entries: string[] = []

  push(line: string): void {
    this.entries.push(line)
    if (this.entries.length > MAX_ENTRIES) {
      this.entries.shift()
    }
  }

  tail(limit = 200, filter?: string): string[] {
    let lines = this.entries
    if (filter) {
      const needle = filter.toLowerCase()
      lines = lines.filter((l) => l.toLowerCase().includes(needle))
    }
    return lines.slice(-limit)
  }

  size(): number {
    return this.entries.length
  }

  clear(): void {
    this.entries = []
  }
}

export const logBuffer = new LogRingBuffer()

/**
 * Stream "writable" pro pino — captura cada linha JSON e empurra no ring.
 * Usar com pino.multistream pra duplicar logs (stdout + ring).
 */
export const logBufferStream = {
  write(chunk: string): void {
    // pino chama write() linha-por-linha em JSON (separadas por \n)
    const trimmed = chunk.trim()
    if (trimmed) logBuffer.push(trimmed)
  },
}
