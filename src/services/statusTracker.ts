interface TaskStatus {
  lastRun: Date | null;
  success: boolean;
  message?: string;
}

const taskStatuses = new Map<string, TaskStatus>();

export function recordTaskRun(taskName: string, success: boolean, message?: string): void {
  taskStatuses.set(taskName, { lastRun: new Date(), success, message });
}

export function getTaskStatus(taskName: string): TaskStatus | undefined {
  return taskStatuses.get(taskName);
}
