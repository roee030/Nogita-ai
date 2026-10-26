import type { ActionReceipt, BoardPort, CreateTask } from '../core/contracts.ts';

export class MondayBoard implements BoardPort {
  readonly name = 'monday';
  constructor(private readonly token: string, private readonly boardId: number, private readonly descriptionColumnId: string, private readonly http: typeof fetch = fetch) {
    if (!token || !Number.isSafeInteger(boardId) || boardId < 1) throw new Error('Monday credentials/board ID invalid');
  }
  async createTask(task: CreateTask): Promise<ActionReceipt> {
    if (task.assigneeId) throw new Error('monday assignee mapping requires board column metadata; not yet implemented');
    if (task.description && !/^[A-Za-z0-9_]+$/.test(this.descriptionColumnId)) {
      throw new Error('monday description column mapping required; refusing to drop task details');
    }
    const columnValues = task.description ? JSON.stringify({ [this.descriptionColumnId]: task.description }) : '{}';
    const res = await this.http('https://api.monday.com/v2', {
      method: 'POST',
      headers: { Authorization: this.token, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: 'mutation ($board: ID!, $name: String!, $values: JSON!) { create_item(board_id: $board, item_name: $name, column_values: $values) { id name url } }',
        variables: { board: String(this.boardId), name: task.title, values: columnValues },
      }),
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) throw new Error(`monday create failed: HTTP ${res.status}`);
    const payload = await res.json() as { errors?: unknown[]; data?: { create_item?: { id: string; url: string } } };
    if (payload.errors?.length || !payload.data?.create_item?.url) throw new Error('monday GraphQL returned an error/no item');
    const { id, url } = payload.data.create_item;
    return { provider: 'monday', kind: 'task', label: `monday item ${id}`, url };
  }
}
