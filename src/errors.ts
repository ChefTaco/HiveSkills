// The suite error envelope for every HiveSkills error answer:
// `{ "error": { "code", "message", "requestId" } }`, built with @hivemagnus/hive-common.
import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { HiveError, defaultCodeForStatus, defaultMessageForStatus, toErrorResponse } from '@hivemagnus/hive-common/errors';
import { getHiveContext } from '@hivemagnus/hive-common/hono';

export { HiveError };

type ErrorStatus = 400 | 401 | 403 | 404 | 409 | 413 | 429 | 500 | 503;

/** An error answer in the envelope, for a handler that returns rather than throws. */
export function errorJson(c: Context, status: ErrorStatus, message: string, code = defaultCodeForStatus(status)): Response {
  return render(c, new HiveError(code, message, { status }));
}

/** `429` with `Retry-After`. */
export const rateLimited = (retryAfterSeconds: number): HiveError =>
  new HiveError('rate_limited', 'Try again shortly', { status: 429, headers: { 'retry-after': String(retryAfterSeconds) } });

function render(c: Context, error: unknown): Response {
  const requestId = getHiveContext(c)?.requestId;
  const answer = toErrorResponse(error, { requestId, onUnexpected: (unexpected) => console.error(unexpected) });
  return c.json(answer.body, answer.status as ErrorStatus, answer.headers);
}

/**
 * `app.onError`. A HiveError keeps its code and message. An HTTPException keeps its status and,
 * below 500, its message, with the default code for the status; at 500 and above the message is
 * the generic one for the status, as before. Anything else is a logged, generic 500.
 */
export function onError(error: Error, c: Context): Response {
  if (error instanceof HTTPException) {
    const status = error.status;
    const message = status >= 500 ? defaultMessageForStatus(status) : error.message || defaultMessageForStatus(status);
    if (status === 500) console.error(error);
    return render(c, new HiveError(defaultCodeForStatus(status), message, { status }));
  }
  return render(c, error);
}
