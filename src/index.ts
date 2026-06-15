interface ExtensionUIContext {
	setWorkingMessage(message?: string): void;
	setWorkingIndicator(options?: { frames?: string[]; intervalMs?: number }): void;
	setHiddenThinkingLabel(label?: string): void;
}

interface ExtensionContext {
	ui: ExtensionUIContext;
}

interface AssistantMessage {
	role?: string;
	content?: unknown;
	usage?: {
		input?: number;
		output?: number;
	};
}

interface AgentEventMap {
	session_start: unknown;
	agent_start: unknown;
	before_provider_payload: { payload: unknown };
	message_start: { message: AssistantMessage };
	message_update: { message: AssistantMessage; assistantMessageEvent: { type?: string; delta?: unknown } };
	message_end: { message: AssistantMessage };
	tool_execution_start: unknown;
	agent_end: unknown;
	session_shutdown: unknown;
}

interface ExtensionAPI {
	on<K extends keyof AgentEventMap>(
		eventName: K,
		handler: (event: AgentEventMap[K], ctx: ExtensionContext) => void,
	): void;
}

const DEFAULT_PHASE = "Working";
const THINKING_PHASE = "Thinking";
const HIDDEN_THINKING_LABEL = "";
const UPDATE_INTERVAL_MS = 1_000;
export const IDLE_TAKING_A_WHILE_THRESHOLD_MS = 60_000;
export const IDLE_PROBABLY_IDLE_THRESHOLD_MS = 180_000;
export const IDLE_THRESHOLD_MS = 300_000;
export const IDLE_TAKING_A_WHILE_NOTICE = "- agent is taking a while...";
export const IDLE_PROBABLY_IDLE_NOTICE = "- agent is probably idle...";
export const IDLE_NOTICE = "- agent is idle";
const APPROX_CHARS_PER_TOKEN = 4;
const ANSI_YELLOW = "\u001b[33m";
const ANSI_RED = "\u001b[31m";
const ANSI_RESET = "\u001b[0m";

export type Phase = typeof DEFAULT_PHASE | typeof THINKING_PHASE;
type TokenDirection = "up" | "down";
type IdleColor = "yellow" | "red";

const TOKEN_DIRECTION_ARROW: Record<TokenDirection, string> = {
	up: "↑",
	down: "↓",
};

export interface ActiveRun {
	startedAt: number;
	lastTokenAt: number;
	phase: Phase;
	tokenDirection: TokenDirection;
	requestInputTokens: number;
	completedOutputTokens: number;
	currentMessageOutputTokens: number;
}

let activeRun: ActiveRun | undefined;
let updateTimer: ReturnType<typeof setInterval> | undefined;

export const formatElapsed = (elapsedMs: number): string => {
	const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1_000));
	const hours = Math.floor(totalSeconds / 3_600);
	const minutes = Math.floor((totalSeconds % 3_600) / 60);
	const seconds = totalSeconds % 60;

	if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
	if (minutes > 0) return `${minutes}m ${seconds}s`;
	return `${seconds}s`;
};

export const formatCompactTokens = (tokens: number): string => {
	const rounded = Math.max(0, Math.round(tokens));
	if (rounded < 1_000) return `${rounded} tokens`;
	if (rounded < 1_000_000) return `${(rounded / 1_000).toFixed(1)}k tokens`;
	return `${(rounded / 1_000_000).toFixed(1)}m tokens`;
};

const estimateTokensFromText = (text: string): number => Math.ceil(text.length / APPROX_CHARS_PER_TOKEN);

const colorText = (text: string, color: IdleColor): string => {
	const ansiColor = color === "red" ? ANSI_RED : ANSI_YELLOW;
	return `${ansiColor}${text}${ANSI_RESET}`;
};

const stringifyLength = (value: unknown): number => {
	if (value === undefined) return 0;
	try {
		return JSON.stringify(value).length;
	} catch {
		return 0;
	}
};

const estimateTokensFromUnknown = (value: unknown): number =>
	Math.ceil(stringifyLength(value) / APPROX_CHARS_PER_TOKEN);

const estimateOutputTokensFromContent = (content: unknown): number => {
	if (!Array.isArray(content)) return 0;

	let chars = 0;
	for (const item of content) {
		if (!item || typeof item !== "object") continue;
		const part = item as Record<string, unknown>;

		if (part.type === "text" && typeof part.text === "string") {
			chars += part.text.length;
			continue;
		}

		if (part.type === "thinking" && typeof part.thinking === "string") {
			chars += part.thinking.length;
			continue;
		}

		if (part.type === "toolCall") {
			if (typeof part.name === "string") chars += part.name.length;
			if (typeof part.partialJson === "string") chars += part.partialJson.length;
			chars += stringifyLength(part.arguments);
		}
	}

	return Math.ceil(chars / APPROX_CHARS_PER_TOKEN);
};

export const currentRunOutputTokens = (run: ActiveRun): number =>
	run.completedOutputTokens + run.currentMessageOutputTokens;

const currentDisplayedTokens = (run: ActiveRun): number =>
	run.tokenDirection === "up" ? run.requestInputTokens : currentRunOutputTokens(run);

export const IDLE_STAGES: ReadonlyArray<{ thresholdMs: number; notice: string; color: IdleColor }> = [
	{ thresholdMs: IDLE_THRESHOLD_MS, notice: IDLE_NOTICE, color: "red" },
	{ thresholdMs: IDLE_PROBABLY_IDLE_THRESHOLD_MS, notice: IDLE_PROBABLY_IDLE_NOTICE, color: "yellow" },
	{ thresholdMs: IDLE_TAKING_A_WHILE_THRESHOLD_MS, notice: IDLE_TAKING_A_WHILE_NOTICE, color: "yellow" },
];

export const getIdleStage = (
	run: ActiveRun,
	now = Date.now(),
): { thresholdMs: number; notice: string; color: IdleColor } | undefined =>
	IDLE_STAGES.find((stage) => now - run.lastTokenAt > stage.thresholdMs);

export const isRunIdle = (run: ActiveRun, now = Date.now()): boolean =>
	getIdleStage(run, now) !== undefined;

export const buildWorkingMessage = (run: ActiveRun, now = Date.now()): string => {
	const tokenArrow = TOKEN_DIRECTION_ARROW[run.tokenDirection];
	const baseMessage = `${run.phase}… (${formatElapsed(now - run.startedAt)} · ${tokenArrow} ${formatCompactTokens(currentDisplayedTokens(run))})`;
	const idleStage = getIdleStage(run, now);
	return idleStage ? `${baseMessage} ${colorText(idleStage.notice, idleStage.color)}` : baseMessage;
};

const markTokenActivity = (run: ActiveRun, direction: TokenDirection): void => {
	run.tokenDirection = direction;
	run.lastTokenAt = Date.now();
};

const setRequestInputTokens = (run: ActiveRun, tokens: number): void => {
	if (!Number.isFinite(tokens) || tokens <= 0) return;
	run.requestInputTokens = Math.round(tokens);
	markTokenActivity(run, "up");
};

const updateWorkingMessage = (ctx: ExtensionContext, run: ActiveRun): void => {
	ctx.ui.setWorkingMessage(buildWorkingMessage(run));
};

const setPhase = (ctx: ExtensionContext, run: ActiveRun, phase: Phase): void => {
	if (run.phase !== phase) run.phase = phase;
	updateWorkingMessage(ctx, run);
};

const clearUpdateTimer = (): void => {
	if (updateTimer === undefined) return;
	clearInterval(updateTimer);
	updateTimer = undefined;
};

const restoreWorkingDefaults = (ctx: ExtensionContext): void => {
	ctx.ui.setWorkingMessage();
	ctx.ui.setWorkingIndicator();
};

const restoreAllDefaults = (ctx: ExtensionContext): void => {
	restoreWorkingDefaults(ctx);
	ctx.ui.setHiddenThinkingLabel();
};

const stopRun = (ctx: ExtensionContext): void => {
	clearUpdateTimer();
	activeRun = undefined;
	restoreWorkingDefaults(ctx);
};

const startRun = (ctx: ExtensionContext): void => {
	clearUpdateTimer();

	const now = Date.now();
	const run: ActiveRun = {
		startedAt: now,
		lastTokenAt: now,
		phase: DEFAULT_PHASE,
		tokenDirection: "up",
		requestInputTokens: 0,
		completedOutputTokens: 0,
		currentMessageOutputTokens: 0,
	};

	activeRun = run;
	ctx.ui.setWorkingIndicator();
	ctx.ui.setHiddenThinkingLabel(HIDDEN_THINKING_LABEL);
	updateWorkingMessage(ctx, run);
	updateTimer = setInterval(() => {
		if (activeRun !== run) return;
		updateWorkingMessage(ctx, run);
	}, UPDATE_INTERVAL_MS);
};

const reconcileCurrentMessageEstimate = (run: ActiveRun, message: unknown): boolean => {
	if (!message || typeof message !== "object") return false;
	const content = (message as { content?: unknown }).content;
	const estimatedTokens = estimateOutputTokensFromContent(content);
	if (estimatedTokens > run.currentMessageOutputTokens) {
		run.currentMessageOutputTokens = estimatedTokens;
		return true;
	}
	return false;
};

const addDeltaEstimate = (run: ActiveRun, assistantMessageEvent: { delta?: unknown }): boolean => {
	if (typeof assistantMessageEvent.delta !== "string" || assistantMessageEvent.delta.length === 0) return false;
	const estimatedTokens = estimateTokensFromText(assistantMessageEvent.delta);
	if (estimatedTokens <= 0) return false;
	run.currentMessageOutputTokens += estimatedTokens;
	return true;
};

const stripThinkingBlocksFromMessage = (message: unknown): void => {
	if (!message || typeof message !== "object") return;
	const content = (message as { content?: unknown }).content;
	if (!Array.isArray(content)) return;

	for (const item of content) {
		if (!item || typeof item !== "object") continue;
		const part = item as { type?: unknown; thinking?: unknown };
		if (part.type === "thinking" && typeof part.thinking === "string") {
			part.thinking = "";
		}
	}
};

const phaseFromAssistantEvent = (assistantMessageEvent: { type?: string }): Phase | undefined => {
	if (assistantMessageEvent.type?.startsWith("thinking_")) return THINKING_PHASE;
	if (
		assistantMessageEvent.type?.startsWith("text_") ||
		assistantMessageEvent.type?.startsWith("toolcall_") ||
		assistantMessageEvent.type === "done"
	) {
		return DEFAULT_PHASE;
	}
	return undefined;
};

export default function thinkingMessagingExtension(pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		clearUpdateTimer();
		activeRun = undefined;
		ctx.ui.setHiddenThinkingLabel(HIDDEN_THINKING_LABEL);
		restoreWorkingDefaults(ctx);
	});

	pi.on("agent_start", (_event, ctx) => {
		startRun(ctx);
	});

	pi.on("before_provider_payload", (event, ctx) => {
		if (!activeRun) return;
		setRequestInputTokens(activeRun, estimateTokensFromUnknown(event.payload));
		updateWorkingMessage(ctx, activeRun);
	});

	pi.on("message_start", (event, ctx) => {
		if (!activeRun || event.message.role !== "assistant") return;
		activeRun.currentMessageOutputTokens = 0;
		stripThinkingBlocksFromMessage(event.message);
		setPhase(ctx, activeRun, DEFAULT_PHASE);
	});

	pi.on("message_update", (event, ctx) => {
		if (!activeRun || event.message.role !== "assistant") return;
		const addedDeltaTokens = addDeltaEstimate(activeRun, event.assistantMessageEvent);
		const increasedEstimate = reconcileCurrentMessageEstimate(activeRun, event.message);
		if (addedDeltaTokens || increasedEstimate) markTokenActivity(activeRun, "down");
		stripThinkingBlocksFromMessage(event.message);
		const phase = phaseFromAssistantEvent(event.assistantMessageEvent);
		if (phase) {
			setPhase(ctx, activeRun, phase);
			return;
		}
		updateWorkingMessage(ctx, activeRun);
	});

	pi.on("message_end", (event, ctx) => {
		if (!activeRun || event.message.role !== "assistant") return;

		reconcileCurrentMessageEstimate(activeRun, event.message);
		stripThinkingBlocksFromMessage(event.message);
		const usageInput = event.message.usage?.input;
		if (typeof usageInput === "number" && Number.isFinite(usageInput) && usageInput > 0) {
			activeRun.requestInputTokens = Math.round(usageInput);
		}
		const usageOutput = event.message.usage?.output;
		const finalOutputTokens =
			typeof usageOutput === "number" && Number.isFinite(usageOutput) && usageOutput > 0
				? usageOutput
				: activeRun.currentMessageOutputTokens;
		if (finalOutputTokens > 0) markTokenActivity(activeRun, "down");
		activeRun.completedOutputTokens += finalOutputTokens;
		activeRun.currentMessageOutputTokens = 0;
		setPhase(ctx, activeRun, DEFAULT_PHASE);
	});

	pi.on("tool_execution_start", (_event, ctx) => {
		if (!activeRun) return;
		setPhase(ctx, activeRun, DEFAULT_PHASE);
	});

	pi.on("agent_end", (_event, ctx) => {
		stopRun(ctx);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		clearUpdateTimer();
		activeRun = undefined;
		restoreAllDefaults(ctx);
	});
}
