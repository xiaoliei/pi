import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setKeybindings, type TUI } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { writeEndpointEntry } from "../src/core/endpoint-config.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import type { ModelRuntime } from "../src/core/model-runtime.ts";
import { ConnectDialogComponent } from "../src/modes/interactive/components/connect-dialog.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const UP = "\x1b[A";
const DOWN = "\x1b[B";
const ENTER = "\r";

function createFakeTui(): TUI {
	return { requestRender: () => {} } as unknown as TUI;
}

function createFakeModelRuntime(modelsPath: string): ModelRuntime {
	return {
		getModelsPath: () => modelsPath,
		refresh: vi.fn().mockResolvedValue({ aborted: false, errors: new Map() }),
	} as unknown as ModelRuntime;
}

function renderedText(dialog: ConnectDialogComponent): string {
	return stripAnsi(dialog.render(120).join("\n"));
}

/** Row containing the arrow marker for the current selection. */
function selectedRow(dialog: ConnectDialogComponent): string | undefined {
	return renderedText(dialog)
		.split("\n")
		.find((line) => line.trimStart().startsWith("→"));
}

function keypress(dialog: ConnectDialogComponent, key: string): void {
	dialog.handleInput(key);
}

describe("ConnectDialogComponent", () => {
	let tempDir: string;
	let modelsPath: string;

	beforeAll(() => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
	});

	async function createDialog(): Promise<ConnectDialogComponent> {
		tempDir = mkdtempSync(join(tmpdir(), "pi-connect-dialog-"));
		modelsPath = join(tempDir, "models.json");
		writeFileSync(modelsPath, JSON.stringify({ providers: {} }));
		await writeEndpointEntry(
			modelsPath,
			{ id: "alpha", name: "Alpha", baseUrl: "https://alpha.example.com/v1", api: "openai-completions" },
			[{ id: "m1", enabled: true, reasoning: false, contextWindow: 8192, maxTokens: 4096, input: ["text"] }],
		);
		await writeEndpointEntry(
			modelsPath,
			{ id: "beta", name: "Beta", baseUrl: "https://beta.example.com/v1", api: "anthropic-messages" },
			[{ id: "m2", enabled: true, reasoning: false, contextWindow: 8192, maxTokens: 4096, input: ["text"] }],
		);
		const dialog = new ConnectDialogComponent(createFakeTui(), {
			modelRuntime: createFakeModelRuntime(modelsPath),
			onClose: () => {},
			onChanged: () => {},
			onStatus: () => {},
			onError: () => {},
		});
		await dialog.open();
		return dialog;
	}

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) rmSync(tempDir, { recursive: true });
		tempDir = undefined as unknown as string;
	});

	it("renders the input field only once on input pages", async () => {
		const dialog = await createDialog();
		// Enter add wizard: select "＋ Add endpoint" (last row)
		keypress(dialog, DOWN);
		keypress(dialog, DOWN);
		keypress(dialog, ENTER);
		const text = renderedText(dialog);
		const promptCount = text.split("> ").length - 1;
		expect(promptCount).toBe(1);
	});

	it("shows a single input whose content matches what the user typed", async () => {
		const dialog = await createDialog();
		keypress(dialog, DOWN);
		keypress(dialog, DOWN);
		keypress(dialog, ENTER);
		keypress(dialog, "h");
		keypress(dialog, "i");
		const text = renderedText(dialog);
		expect(text).toContain("hi");
		// exactly one "> " prompt line across the whole dialog
		expect(text.split("> ").length - 1).toBe(1);
	});

	it("deletes an endpoint after navigating to Delete and confirming", async () => {
		const dialog = await createDialog();
		// manage alpha
		keypress(dialog, ENTER);
		// move to "Delete endpoint" (index 4)
		keypress(dialog, DOWN);
		keypress(dialog, DOWN);
		keypress(dialog, DOWN);
		keypress(dialog, DOWN);
		keypress(dialog, ENTER);
		// confirm-delete page: arrow must track selection
		expect(selectedRow(dialog)?.trim()).toBe("→ Delete");
		keypress(dialog, DOWN);
		expect(selectedRow(dialog)?.trim()).toBe("→ Cancel");
		keypress(dialog, UP);
		expect(selectedRow(dialog)?.trim()).toBe("→ Delete");
		keypress(dialog, ENTER);
		// deletion is async (void this.confirm()) — wait for it to land
		await vi.waitFor(() => {
			const stored = JSON.parse(readFileSync(modelsPath, "utf-8")) as { providers: Record<string, unknown> };
			expect(stored.providers["alpha"]).toBeUndefined();
		});
		await vi.waitFor(() => {
			const text = renderedText(dialog);
			expect(text).toContain("beta");
			expect(text).not.toContain("alpha.example.com");
		});
		const stored = JSON.parse(readFileSync(modelsPath, "utf-8")) as { providers: Record<string, unknown> };
		expect(stored.providers["beta"]).toBeDefined();
	});

	it("keeps the arrow following up/down on the models page", async () => {
		const dialog = await createDialog();
		keypress(dialog, ENTER); // manage alpha
		keypress(dialog, DOWN);
		keypress(dialog, ENTER); // models page
		expect(selectedRow(dialog)).toContain("m1");
		keypress(dialog, DOWN);
		expect(selectedRow(dialog)).toContain("Add model");
		keypress(dialog, DOWN);
		expect(selectedRow(dialog)).toContain("Back");
		keypress(dialog, UP);
		expect(selectedRow(dialog)).toContain("Add model");
	});

	it("arrow follows movement on the confirm-delete page entered via Esc", async () => {
		const dialog = await createDialog();
		keypress(dialog, ENTER); // manage
		for (let i = 0; i < 4; i++) keypress(dialog, DOWN);
		keypress(dialog, ENTER); // confirm-delete
		keypress(dialog, DOWN);
		expect(selectedRow(dialog)?.trim()).toBe("→ Cancel");
	});

	it("clamps selection to the last row on selection pages", async () => {
		const dialog = await createDialog();
		for (let i = 0; i < 10; i++) keypress(dialog, DOWN);
		expect(selectedRow(dialog)).toContain("＋ Add endpoint");
	});
});
