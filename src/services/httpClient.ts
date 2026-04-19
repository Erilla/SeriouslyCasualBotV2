import type { ServiceName } from './apiHealth.js';
import { recordOutcome, noteFailure, noteSuccess } from './apiHealth.js';

export type { ServiceName };

export interface HttpRequestOptions {
  timeoutMs?: number;
  maxRetries?: number;
  parseJson?: boolean;
}

export class HttpError extends Error {
  readonly service: ServiceName;
  readonly status?: number;
  readonly attempts: number;
  readonly lastError?: Error;

  constructor(args: {
    service: ServiceName;
    status?: number;
    attempts: number;
    message: string;
    lastError?: Error;
  }) {
    super(args.message);
    this.name = 'HttpError';
    this.service = args.service;
    this.status = args.status;
    this.attempts = args.attempts;
    this.lastError = args.lastError;
  }
}

export class CircuitOpenError extends Error {
  readonly service: ServiceName;
  constructor(service: ServiceName) {
    super(`Circuit open for ${service}`);
    this.name = 'CircuitOpenError';
    this.service = service;
  }
}

const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);
// NOTE: httpRequest assumes all calls are idempotent. All current callers
// (Raider.io/wowaudit GETs, WarcraftLogs OAuth client_credentials POST and
// GraphQL read queries) are safe to retry. Adding a non-idempotent caller
// in future requires a caller-level opt-out (e.g. `opts.maxRetries = 0`).
export async function httpRequest<T>(
  service: ServiceName,
  url: string,
  init?: RequestInit,
  opts?: HttpRequestOptions,
): Promise<T> {
  const parseJson = opts?.parseJson ?? true;
  const attempts = 1;

  let response: Response;
  try {
    response = await fetch(url, init);
  } catch (err) {
    const e = err instanceof Error ? err : new Error(String(err));
    recordOutcome(service, 'failed', { msg: e.message });
    noteFailure(service);
    throw new HttpError({
      service, attempts, message: `${service} request failed: ${e.message}`, lastError: e,
    });
  }

  if (!response.ok) {
    recordOutcome(service, 'failed', {
      msg: `${response.status} ${response.statusText}`,
      status: response.status,
    });
    noteFailure(service);
    throw new HttpError({
      service, attempts, status: response.status,
      message: `${service} API error: ${response.status} ${response.statusText}`,
    });
  }

  if (!parseJson) {
    recordOutcome(service, 'ok');
    noteSuccess(service);
    return undefined as T;
  }

  try {
    const data = (await response.json()) as T;
    recordOutcome(service, 'ok');
    noteSuccess(service);
    return data;
  } catch (err) {
    const e = err instanceof Error ? err : new Error(String(err));
    recordOutcome(service, 'failed', { msg: `JSON parse error: ${e.message}` });
    noteFailure(service);
    throw new HttpError({
      service, attempts,
      message: `${service} JSON parse error: ${e.message}`, lastError: e,
    });
  }
}
