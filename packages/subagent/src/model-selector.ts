/**
 * Searchable model selector for the /agents command.
 *
 * Mirrors the /models selector layout: search input on top, 10-row windowed
 * list below, rows formatted "id [provider]" with the provider badge muted,
 * ✓ marking the current setting. Rendered via ctx.ui.custom(), so no
 * coding-agent changes are required.
 */

import type { Theme } from "@mariozechner/pi-coding-agent";
import { Container, fuzzyFilter, getKeybindings, Input, Spacer, Text, type TUI } from "@mariozechner/pi-tui";

/** Minimal structural type over Model<Api>; no mapping needed. */
interface SelectableModel {
	provider: string;
	id: string;
	name: string;
}

type SelectorEntry = { kind: "inherit" } | { kind: "model"; model: SelectableModel };

const MAX_VISIBLE = 10;

export class ModelSearchSelector extends Container {
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly options: SelectorEntry[];
	private readonly listContainer: Container;
	private readonly searchInput: Input;
	private readonly done: (result: string | undefined) => void;
	private readonly currentKey: string;
	private filtered: SelectorEntry[];
	private selectedIndex = 0;

	constructor(
		tui: TUI,
		theme: Theme,
		title: string,
		models: SelectableModel[],
		done: (result: string | undefined) => void,
		currentModel: string | null,
	) {
		super();
		this.tui = tui;
		this.theme = theme;
		this.options = [{ kind: "inherit" }, ...models.map((model): SelectorEntry => ({ kind: "model", model }))];
		this.filtered = this.options;
		this.done = done;
		this.currentKey = currentModel ?? "inherit";

		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));
		this.addChild(new Spacer(1));
		this.searchInput = new Input();
		this.addChild(this.searchInput);
		this.addChild(new Spacer(1));
		this.listContainer = new Container();
		this.addChild(this.listContainer);
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("muted", "  ↑↓ navigate · Enter select · Esc cancel"), 1, 0));
		this.addChild(new Spacer(1));

		// Start with the arrow on the current setting (✓ row, inherit when unset).
		this.selectedIndex = Math.max(
			0,
			this.options.findIndex(
				(e) => e.kind === (currentModel ? "model" : "inherit") && this.entryValue(e) === this.currentKey,
			),
		);

		this.updateList();
		this.tui.requestRender();
	}

	/** Stored config value: "provider/id", or "inherit". */
	private entryValue(entry: SelectorEntry): string {
		return entry.kind === "inherit" ? "inherit" : `${entry.model.provider}/${entry.model.id}`;
	}

	private label(entry: SelectorEntry): string {
		if (entry.kind === "inherit") return "inherit";
		const { id, provider } = entry.model;
		return `${id} ${this.theme.fg("muted", `[${provider}]`)}`;
	}

	private updateList(): void {
		this.listContainer.clear();
		const total = this.filtered.length;
		const startIndex = Math.max(0, Math.min(this.selectedIndex - Math.floor(MAX_VISIBLE / 2), total - MAX_VISIBLE));
		const endIndex = Math.min(startIndex + MAX_VISIBLE, total);

		for (let i = startIndex; i < endIndex; i++) {
			const entry = this.filtered[i];
			if (!entry) continue;
			const isSelected = i === this.selectedIndex;
			const isCurrent = this.entryValue(entry) === this.currentKey;
			const checkmark = isCurrent ? this.theme.fg("success", " ✓") : "";
			const line = isSelected
				? this.theme.fg("accent", "→ ") + this.theme.fg("accent", this.label(entry)) + checkmark
				: `  ${this.theme.fg("text", this.label(entry))}${checkmark}`;
			this.listContainer.addChild(new Text(line, 1, 0));
		}

		if (total === 0) {
			this.listContainer.addChild(new Text(this.theme.fg("muted", "  No matching models"), 1, 0));
			return;
		}
		if (startIndex > 0 || endIndex < total) {
			this.listContainer.addChild(new Text(this.theme.fg("muted", `  (${this.selectedIndex + 1}/${total})`), 1, 0));
		}
	}

	private applyFilter(): void {
		const query = this.searchInput.getValue();
		this.filtered = query
			? fuzzyFilter(this.options, query, (e) => {
					if (e.kind === "inherit") return "inherit";
					const { id, provider, name } = e.model;
					return `${id} ${provider} ${name}`;
				})
			: this.options;
		// When filtering, jump to the best match; when cleared, keep the position
		// clamped to the restored list length.
		this.selectedIndex = query ? 0 : Math.min(this.selectedIndex, Math.max(0, this.filtered.length - 1));
		this.updateList();
		this.tui.requestRender();
	}

	private confirm(): void {
		const entry = this.filtered[this.selectedIndex];
		if (entry) this.done(this.entryValue(entry));
	}

	handleInput(keyData: string): void {
		const kb = getKeybindings();
		const delta = kb.matches(keyData, "tui.select.up") ? -1 : kb.matches(keyData, "tui.select.down") ? 1 : 0;
		if (delta !== 0 && this.filtered.length > 0) {
			const total = this.filtered.length;
			this.selectedIndex = (this.selectedIndex + delta + total) % total;
			this.updateList();
			this.tui.requestRender();
			return;
		}
		if (kb.matches(keyData, "tui.select.confirm")) {
			this.confirm();
		} else if (kb.matches(keyData, "tui.select.cancel")) {
			this.done(undefined);
		} else {
			this.searchInput.handleInput(keyData);
			this.applyFilter();
		}
	}
}
