/**
 * Shared JSON response helper. All JSON responses get safe defaults:
 * - application/json content type
 * - Cache-Control: no-store (prevent intermediaries from caching dynamic state)
 * - X-Content-Type-Options: nosniff (prevent MIME sniffing)
 *
 * Caller-supplied headers are merged last so they may override any default.
 */
export function json(
	data: unknown,
	status = 200,
	headers: HeadersInit = {},
): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: {
			"Content-Type": "application/json",
			"Cache-Control": "no-store",
			"X-Content-Type-Options": "nosniff",
			...headers,
		},
	});
}
