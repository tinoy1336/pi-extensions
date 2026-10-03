/**
 * message.ts — the one spelling of an error's text.
 *
 * Every extension reports a failure as a one-line reason: in a diagnostics row, in a
 * refusal, or in a tool result. Each of them used to spell the same ternary for itself,
 * and three copies of it existed when this module was written. One copy keeps a reason
 * the same shape everywhere, which is what makes a log line readable across packages.
 *
 * The argument is `unknown` on purpose: a rejected promise carries anything, and a
 * conversion that cannot throw is the point of the helper.
 */

/** The message of an error, or the value rendered when it is not one. */
export function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
