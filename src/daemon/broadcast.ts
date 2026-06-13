import type { WebSocket } from 'ws';

interface Client {
  ws: WebSocket;
  project: string | null; // null = subscribed to all projects
}

export class Broadcaster {
  private clients = new Set<Client>();

  add(ws: WebSocket, project: string | null): void {
    const client: Client = { ws, project };
    this.clients.add(client);
    ws.on('close', () => this.clients.delete(client));
  }

  /** Send a message to every client subscribed to this project (or to all). */
  send(projectId: string, msg: unknown): void {
    const data = JSON.stringify(msg);
    for (const { ws, project } of this.clients) {
      if (project === null || project === projectId) ws.send(data);
    }
  }

  /** Send to every client regardless of project (account-level data). */
  sendAll(msg: unknown): void {
    const data = JSON.stringify(msg);
    for (const { ws } of this.clients) ws.send(data);
  }
}
