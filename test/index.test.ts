import assert from "node:assert/strict";
import test from "node:test";

import thinkingMessagingExtension, {
	buildWorkingMessage,
	IDLE_NOTICE,
	IDLE_PROBABLY_IDLE_NOTICE,
	IDLE_PROBABLY_IDLE_THRESHOLD_MS,
	IDLE_TAKING_A_WHILE_NOTICE,
	IDLE_TAKING_A_WHILE_THRESHOLD_MS,
	IDLE_THRESHOLD_MS,
	type ActiveRun,
} from "../src/index.ts";

const ANSI_YELLOW = "\u001b[33m";
const ANSI_RED = "\u001b[31m";
const ANSI_RESET = "\u001b[0m";

const makeRun = (overrides: Partial<ActiveRun> = {}): ActiveRun => ({
	startedAt: 0,
	lastTokenAt: 0,
	phase: "Working",
	tokenDirection: "up",
	requestInputTokens: 1_200,
	completedOutputTokens: 0,
	currentMessageOutputTokens: 0,
	...overrides,
});

type FakeContext = {
	ui: {
		setWorkingMessage(message?: string): void;
		setWorkingIndicator(options?: { frames?: string[]; intervalMs?: number }): void;
		setHiddenThinkingLabel(label?: string): void;
	};
};

type Handler = (event: any, ctx: FakeContext) => void;

test("shows an up arrow for request/input tokens", () => {
	const message = buildWorkingMessage(makeRun({ requestInputTokens: 1_200 }), 1_000);

	assert.match(message, /↑ 1\.2k tokens/);
	assert.doesNotMatch(message, /↓/);
	assert.doesNotMatch(message, new RegExp(IDLE_NOTICE));
});

test("shows a down arrow while keeping the token count cumulative", () => {
	const message = buildWorkingMessage(
		makeRun({
			tokenDirection: "down",
			requestInputTokens: 1_200,
			completedOutputTokens: 1_000,
			currentMessageOutputTokens: 250,
		}),
		1_000,
	);

	assert.match(message, /↓ 2\.5k tokens/);
	assert.doesNotMatch(message, /↑/);
});

test("counts only current talk for uploaded provider request tokens", () => {
	const handlers: Record<string, Handler> = {};
	const workingMessages: Array<string | undefined> = [];

	const originalSetInterval = globalThis.setInterval;
	const originalClearInterval = globalThis.clearInterval;
	globalThis.setInterval = ((_callback: () => void) => 123 as unknown as ReturnType<typeof setInterval>) as typeof setInterval;
	globalThis.clearInterval = ((_timer: ReturnType<typeof setInterval>) => {}) as typeof clearInterval;

	try {
		thinkingMessagingExtension({
			on: (eventName: string, handler: Handler) => {
				handlers[eventName] = handler;
			},
		});

		const ctx: FakeContext = {
			ui: {
				setWorkingMessage: (message) => workingMessages.push(message),
				setWorkingIndicator: () => {},
				setHiddenThinkingLabel: () => {},
			},
		};
		const talk = "x".repeat(4_800);
		const payloadWithPromptOverhead = {
			system: "system prompt overhead".repeat(2_000),
			tools: [{ name: "tool", description: "tool schema overhead".repeat(2_000) }],
			messages: [{ role: "user", content: talk }],
		};

		handlers.before_agent_start?.({ prompt: talk }, ctx);
		handlers.agent_start?.({}, ctx);
		handlers.before_provider_request?.({ payload: payloadWithPromptOverhead }, ctx);

		assert.match(workingMessages.at(-1) ?? "", /↑ 1\.2k tokens/);
		assert.doesNotMatch(workingMessages.at(-1) ?? "", /34\.0k tokens/);

		handlers.message_end?.(
			{ message: { role: "assistant", content: [], usage: { input: 34_000, output: 300 } } },
			ctx,
		);

		assert.match(workingMessages.at(-1) ?? "", /↓ 1\.5k tokens/);
		assert.doesNotMatch(workingMessages.at(-1) ?? "", /34\.0k tokens/);
	} finally {
		handlers.agent_end?.(
			{},
			{
				ui: {
					setWorkingMessage: () => {},
					setWorkingIndicator: () => {},
					setHiddenThinkingLabel: () => {},
				},
			},
		);
		globalThis.setInterval = originalSetInterval;
		globalThis.clearInterval = originalClearInterval;
	}
});

test("does not show an idle notice at exactly 60 seconds without token activity", () => {
	const message = buildWorkingMessage(makeRun({ lastTokenAt: 0 }), IDLE_TAKING_A_WHILE_THRESHOLD_MS);

	assert.doesNotMatch(message, /agent is/);
});

test("appends the taking-a-while notice in yellow after more than 60 seconds", () => {
	const message = buildWorkingMessage(makeRun({ lastTokenAt: 0 }), IDLE_TAKING_A_WHILE_THRESHOLD_MS + 1);

	assert.ok(message.includes(`${ANSI_YELLOW}${IDLE_TAKING_A_WHILE_NOTICE}${ANSI_RESET}`));
});

test("appends the probably-idle notice in yellow after more than 180 seconds", () => {
	const message = buildWorkingMessage(makeRun({ lastTokenAt: 0 }), IDLE_PROBABLY_IDLE_THRESHOLD_MS + 1);

	assert.ok(message.includes(`${ANSI_YELLOW}${IDLE_PROBABLY_IDLE_NOTICE}${ANSI_RESET}`));
	assert.doesNotMatch(message, new RegExp(IDLE_TAKING_A_WHILE_NOTICE));
});

test("appends the idle notice in red after more than 300 seconds", () => {
	const message = buildWorkingMessage(makeRun({ lastTokenAt: 0 }), IDLE_THRESHOLD_MS + 1);

	assert.ok(message.includes(`${ANSI_RED}${IDLE_NOTICE}${ANSI_RESET}`));
	assert.doesNotMatch(message, new RegExp(IDLE_PROBABLY_IDLE_NOTICE));
});

test("clears the update timer and restores loader defaults on agent_end", () => {
	const handlers: Record<string, Handler> = {};
	const workingMessages: Array<string | undefined> = [];
	const workingIndicators: Array<{ frames?: string[]; intervalMs?: number } | undefined> = [];
	const hiddenThinkingLabels: Array<string | undefined> = [];
	let clearIntervalCalled = false;
	let intervalCallback: (() => void) | undefined;

	const originalSetInterval = globalThis.setInterval;
	const originalClearInterval = globalThis.clearInterval;
	globalThis.setInterval = ((callback: () => void) => {
		intervalCallback = callback;
		return 123 as unknown as ReturnType<typeof setInterval>;
	}) as typeof setInterval;
	globalThis.clearInterval = ((timer: ReturnType<typeof setInterval>) => {
		if ((timer as unknown as number) === 123) clearIntervalCalled = true;
	}) as typeof clearInterval;

	try {
		thinkingMessagingExtension({
			on: (eventName: string, handler: Handler) => {
				handlers[eventName] = handler;
			},
		});

		const ctx: FakeContext = {
			ui: {
				setWorkingMessage: (message) => workingMessages.push(message),
				setWorkingIndicator: (options) => workingIndicators.push(options),
				setHiddenThinkingLabel: (label) => hiddenThinkingLabels.push(label),
			},
		};

		handlers.agent_start?.({}, ctx);
		assert.equal(typeof intervalCallback, "function");

		handlers.agent_end?.({}, ctx);
		intervalCallback?.();

		assert.equal(clearIntervalCalled, true);
		assert.equal(workingMessages.at(-1), undefined);
		assert.equal(workingIndicators.at(-1), undefined);
		assert.deepEqual(hiddenThinkingLabels, [""]);
	} finally {
		globalThis.setInterval = originalSetInterval;
		globalThis.clearInterval = originalClearInterval;
	}
});
