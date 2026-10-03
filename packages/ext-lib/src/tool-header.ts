/**
 * tool-header — the shared `renderCall` header builder for the local extensions.
 *
 * pi bundles its TUI inside the agent and does not expose `@earendil-works/pi-tui`
 * to extensions, so a header cannot be a `Text`; it must be a duck-typed
 * component (`render(width)` + `invalidate()`), the shape
 * the deepseek-cost entry uses for its entry renderer.
 *
 * A header is ONE line: the tool name plus the few fields a reader needs to
 * follow the transcript. Free text is flattened and clipped before theming, so
 * no ANSI sequence is ever cut; a narrower terminal wraps the line without
 * losing the colour in force.
 */

export interface HeaderTheme {
	// `any` on the colour keeps pi's richer Theme assignable to this narrow shape
	fg?: (colour: any, text: string) => string;
	bold?: (text: string) => string;
}

export interface HeaderComponent {
	render(width: number): string[];
	invalidate(): void;
}

/** One coloured run of a header line: [theme colour, text]. */
export type HeaderPart = readonly [string, string];

/** The escape character every SGR sequence starts with. */
const ESC = "\u001b";

// Composed from ESC rather than written as a regex literal: the sequence that matches a
// control character is rejected in a literal, and this pattern needs exactly that one.
const SGR = `${ESC}\\[[0-9;]*m`;
const SGR_AT_START = new RegExp(`^${SGR}`);
const SGR_ANYWHERE = new RegExp(SGR, "g");

/** Flatten whitespace and clip to `max` characters with an ellipsis. */
export function clip(text: string, max = 80): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, Math.max(1, max - 1))}…` : flat;
}

/** A non-empty trimmed string argument, or undefined. */
export function argText(args: unknown, key: string): string | undefined {
	const value = (args as Record<string, unknown> | null | undefined)?.[key];
	return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

/** A finite numeric argument, or undefined. */
export function argNumber(args: unknown, key: string): number | undefined {
	const value = (args as Record<string, unknown> | null | undefined)?.[key];
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Visible width (SGR sequences are zero-width). */
function visibleWidth(text: string): number {
	return text.replace(SGR_ANYWHERE, "").length;
}

/** Break an over-long segment at `width`, re-applying the colour in force. */
function splitSegment(segment: string, width: number, lines: string[]): string {
	let current = "";
	let colour = "";
	let visible = 0;
	for (let i = 0; i < segment.length; ) {
		const sgr = SGR_AT_START.exec(segment.slice(i, i + 16));
		if (sgr) {
			colour = sgr[0];
			current += sgr[0];
			i += sgr[0].length;
			continue;
		}
		if (visible >= width) {
			lines.push(current);
			current = colour;
			visible = 0;
		}
		current += segment[i];
		visible += 1;
		i += 1;
	}
	return current;
}

/** Wrap the header's coloured segments at `width`, never cutting an escape. */
function wrapSegments(segments: string[], width: number): string[] {
	const lines: string[] = [];
	let line = "";
	for (const segment of segments) {
		if (!segment) continue;
		if (line && visibleWidth(line) + visibleWidth(segment) > width) {
			lines.push(line.replace(/\s+$/, ""));
			line = "";
		}
		if (!line && visibleWidth(segment) > width) {
			line = splitSegment(segment, width, lines);
			continue;
		}
		line += segment;
	}
	lines.push(line);
	return lines;
}

/** Build the header component: the tool name bold, then one run per part. */
export function renderToolHeader(theme: HeaderTheme | undefined, name: string, parts: HeaderPart[] = []): HeaderComponent {
	const fg = (colour: string, text: string): string => (theme?.fg ? theme.fg(colour, text) : text);
	const bold = (text: string): string => (theme?.bold ? theme.bold(text) : text);
	const segments = [fg("toolTitle", bold(name))];
	for (const [colour, text] of parts) {
		if (!text) continue;
		segments.push(colour ? fg(colour, text) : text);
	}
	return {
		render: (width: number) => wrapSegments(segments, Math.max(1, Math.floor(width))),
		invalidate: () => {},
	};
}

/** `renderToolHeader` behind a guard: an odd argument set degrades to the name alone. */
export function safeToolHeader(theme: HeaderTheme | undefined, name: string, build: () => HeaderPart[]): HeaderComponent {
	try {
		return renderToolHeader(theme, name, build());
	} catch {
		return renderToolHeader(theme, name);
	}
}
