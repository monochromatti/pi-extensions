(() => {
	const params = new URLSearchParams(window.location.search);
	const token = params.get("token");
	if (!token) return;

	let afterId = 0;
	let inflight = false;
	const signals = {};

	const MIN_POLL_MS = 80;
	const MAX_POLL_MS = 1000;
	let pollDelay = MIN_POLL_MS;
	let pollTimer;
	let sseConnected = false;

	function schedulePoll(delay) {
		clearTimeout(pollTimer);
		pollTimer = window.setTimeout(pollLoop, delay);
	}

	function stopPolling() {
		clearTimeout(pollTimer);
		pollTimer = undefined;
	}

	function pollLoop() {
		if (sseConnected) return;
		pollPatches();
		schedulePoll(pollDelay);
	}

	// Single ingest point for both transports: patch ids increase strictly,
	// so anything at or below afterId has already been applied. This keeps
	// append/prepend patches from double-applying if SSE and a poll race.
	function ingestPatch(patch) {
		if (!patch || typeof patch.id !== "number" || patch.id <= afterId) return false;
		afterId = patch.id;
		applyPatch(patch);
		return true;
	}

	function applyPatch(patch) {
		if (!patch || typeof patch.selector !== "string") return;
		const target = document.querySelector(patch.selector);
		if (!target) return;
		const html = typeof patch.html === "string" ? patch.html : "";
		switch (patch.mode) {
			case "outer":
				target.outerHTML = html;
				break;
			case "append":
				target.insertAdjacentHTML("beforeend", html);
				break;
			case "prepend":
				target.insertAdjacentHTML("afterbegin", html);
				break;
			case "inner":
			default:
				target.innerHTML = html;
		}
		updateReactiveBindings();
		refreshCommentHighlights();
		refreshPendingComment();
	}

	// Declarative visibility/enablement bound to the signal store. Only bare
	// signal keys (optionally negated with "!") are accepted -- no expression
	// evaluation, so agent HTML never executes logic.
	const REACTIVE_KEY_PATTERN = /^!?[a-z0-9_.-]+$/i;

	function parseReactiveKey(raw) {
		if (typeof raw !== "string") return undefined;
		const value = raw.trim();
		if (!REACTIVE_KEY_PATTERN.test(value)) return undefined;
		const negated = value.startsWith("!");
		return { key: negated ? value.slice(1) : value, negated };
	}

	function isTruthySignal(value) {
		if (value === undefined || value === null || value === false) return false;
		if (typeof value === "string") return value.trim().length > 0;
		if (Array.isArray(value)) return value.length > 0;
		return true;
	}

	function updateReactiveBindings() {
		for (const element of document.querySelectorAll("[data-show]")) {
			const parsed = parseReactiveKey(element.getAttribute("data-show"));
			if (!parsed) continue;
			const on = isTruthySignal(signals[parsed.key]) !== parsed.negated;
			element.hidden = !on;
		}
		for (const element of document.querySelectorAll("[data-enable-when]")) {
			const parsed = parseReactiveKey(element.getAttribute("data-enable-when"));
			if (!parsed) continue;
			if (!("disabled" in element)) continue;
			element.disabled = isTruthySignal(signals[parsed.key]) === parsed.negated;
		}
	}

	function connectStream() {
		if (typeof window.EventSource !== "function") {
			pollLoop();
			return;
		}

		const source = new EventSource(`/stream?token=${encodeURIComponent(token)}&after=${afterId}`);

		source.addEventListener("open", () => {
			sseConnected = true;
			stopPolling();
			document.documentElement.setAttribute("data-canvas-transport", "sse");
		});

		source.addEventListener("patch", (event) => {
			try {
				ingestPatch(JSON.parse(event.data));
			} catch {
				// ignore malformed patch payloads
			}
		});

		source.addEventListener("error", () => {
			// EventSource reconnects on its own; poll in the meantime so the
			// canvas stays live even if SSE never comes back.
			sseConnected = false;
			document.documentElement.setAttribute("data-canvas-transport", "poll");
			if (pollTimer === undefined) {
				pollDelay = MIN_POLL_MS;
				pollLoop();
			}
		});
	}

	function pollPatches() {
		if (inflight) return;
		inflight = true;

		const request = new XMLHttpRequest();
		request.open("GET", `/patches?token=${encodeURIComponent(token)}&after=${afterId}`);
		request.onreadystatechange = () => {
			if (request.readyState !== XMLHttpRequest.DONE) return;
			inflight = false;
			if (request.status !== 200) return;
			try {
				const body = JSON.parse(request.responseText);
				const patches = Array.isArray(body?.patches) ? body.patches : [];
				let applied = 0;
				for (const patch of patches) {
					if (ingestPatch(patch)) applied++;
				}
				if (applied > 0) {
					// Activity: poll fast and reschedule immediately.
					pollDelay = MIN_POLL_MS;
					if (!sseConnected) schedulePoll(MIN_POLL_MS);
				} else {
					// Idle: back off up to MAX_POLL_MS to cut request churn.
					pollDelay = Math.min(MAX_POLL_MS, Math.round(pollDelay * 1.5));
				}
			} catch {
				// ignore malformed patch payloads
			}
		};
		request.send();
	}

	function pokePoll() {
		// Local interaction likely triggers a server-side patch; poll soon
		// unless SSE delivers pushes already.
		if (sseConnected) return;
		pollDelay = MIN_POLL_MS;
		schedulePoll(MIN_POLL_MS);
	}

	function postJson(pathname, payload, onDone) {
		const request = new XMLHttpRequest();
		request.open("POST", `${pathname}?token=${encodeURIComponent(token)}`);
		request.setRequestHeader("content-type", "application/json");
		if (typeof onDone === "function") {
			request.onreadystatechange = () => {
				if (request.readyState !== XMLHttpRequest.DONE) return;
				let body;
				try {
					body = JSON.parse(request.responseText);
				} catch {
					body = undefined;
				}
				onDone(request.status === 200 && body?.ok === true, body);
			};
		}
		request.send(JSON.stringify(payload));
	}

	function syncSignals() {
		postJson("/sync", { signals: { ...signals } });
	}

	function readElementValue(element) {
		if (element instanceof HTMLInputElement) {
			if (element.type === "checkbox") return element.checked;
			if (element.type === "radio") return element.checked ? element.value : undefined;
			return element.value;
		}
		if (element instanceof HTMLTextAreaElement) return element.value;
		if (element instanceof HTMLSelectElement) {
			if (element.multiple) {
				return [...element.selectedOptions].map((option) => option.value);
			}
			return element.value;
		}
		return undefined;
	}

	function maybeCaptureSignal(target) {
		if (!(target instanceof Element)) return false;
		const element = target.closest("[data-signal]");
		if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement)) {
			return false;
		}
		const key = element.getAttribute("data-signal");
		if (!key) return false;
		const value = readElementValue(element);
		if (value === undefined) return false;
		signals[key] = value;
		return true;
	}

	function parseEventDescriptor(value) {
		if (typeof value !== "string") return undefined;
		const separator = value.indexOf(":");
		if (separator <= 0) return undefined;
		const kind = value.slice(0, separator).trim();
		const name = value.slice(separator + 1).trim();
		if (!name) return undefined;
		if (kind !== "checkpoint" && kind !== "attention") return undefined;
		return { kind, name };
	}

	function parsePayload(raw) {
		if (!raw || typeof raw !== "string") return undefined;
		try {
			return JSON.parse(raw);
		} catch {
			return undefined;
		}
	}

	document.addEventListener("input", (event) => {
		if (!maybeCaptureSignal(event.target)) return;
		updateReactiveBindings();
		syncSignals();
	}, true);

	document.addEventListener("change", (event) => {
		if (!maybeCaptureSignal(event.target)) return;
		updateReactiveBindings();
		syncSignals();
	}, true);

	document.addEventListener("click", (event) => {
		const target = event.target;
		if (!(target instanceof Element)) return;
		const trigger = target.closest("[data-event]");
		if (!(trigger instanceof Element)) return;
		const parsed = parseEventDescriptor(trigger.getAttribute("data-event"));
		if (!parsed) return;

		event.preventDefault();

		const payload = parsePayload(trigger.getAttribute("data-payload"));
		postJson(`/event/${parsed.kind}/${encodeURIComponent(parsed.name)}`, {
			payload,
			signals: { ...signals },
		});
		pokePoll();
	}, true);

	// ------------------------------------------------------- selection comments
	//
	// Freeform review is a built-in capability, not something agents must render:
	// select any text in the document, write a note, and the quoted passage plus
	// the note reach the agent as an attention event. This removes the reason to
	// scatter "any thoughts?" textareas across the canvas.

	const MAX_QUOTE_CHARS = 400;
	const MAX_HIGHLIGHTS = 50;
	const COMMENT_SCOPE = "#root, #sidebar";

	// The comment log itself lives on the server (see src/comments.ts): it must
	// survive reloads and must not be clobbered by a racing signal sync.
	const commentRanges = [];
	let commentLayer;
	let commentPill;
	let commentComposer;
	let commentQuote;
	let commentInput;
	let commentToastTimer;
	let pendingComment;

	function buildCommentLayer() {
		if (commentLayer) return;

		commentLayer = document.createElement("div");
		commentLayer.id = "canvas-comment-layer";

		commentPill = document.createElement("button");
		commentPill.type = "button";
		commentPill.className = "canvas-comment-pill";
		commentPill.textContent = "Comment";
		commentPill.hidden = true;
		commentPill.addEventListener("mousedown", (event) => event.preventDefault());
		commentPill.addEventListener("click", openCommentComposer);
		commentLayer.appendChild(commentPill);

		commentComposer = document.createElement("div");
		commentComposer.className = "canvas-comment-composer";
		commentComposer.hidden = true;

		commentQuote = document.createElement("blockquote");
		commentQuote.className = "canvas-comment-quote";
		commentComposer.appendChild(commentQuote);

		commentInput = document.createElement("textarea");
		commentInput.className = "canvas-comment-input";
		commentInput.setAttribute("placeholder", "Comment on this selection…");
		commentInput.setAttribute("aria-label", "Comment on selection");
		commentInput.addEventListener("keydown", (event) => {
			if (event.key === "Escape") {
				closeCommentUi();
				return;
			}
			if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
				event.preventDefault();
				submitComment();
			}
		});
		commentComposer.appendChild(commentInput);

		const actions = document.createElement("div");
		actions.className = "canvas-comment-actions";

		const cancel = document.createElement("button");
		cancel.type = "button";
		cancel.className = "btn-quiet canvas-comment-cancel";
		cancel.textContent = "Cancel";
		cancel.addEventListener("click", closeCommentUi);
		actions.appendChild(cancel);

		const send = document.createElement("button");
		send.type = "button";
		send.className = "btn-primary canvas-comment-send";
		send.textContent = "Send comment";
		send.addEventListener("click", submitComment);
		actions.appendChild(send);

		commentComposer.appendChild(actions);
		commentLayer.appendChild(commentComposer);

		const toast = document.createElement("p");
		toast.className = "canvas-comment-toast";
		toast.hidden = true;
		commentLayer.appendChild(toast);

		document.body.appendChild(commentLayer);
	}

	function closestElement(node) {
		if (!node) return undefined;
		return node.nodeType === 1 ? node : node.parentElement || undefined;
	}

	function readSelection() {
		const selection = window.getSelection?.();
		if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return undefined;

		const activeElement = document.activeElement;
		if (activeElement && /^(TEXTAREA|INPUT|SELECT)$/.test(activeElement.tagName)) return undefined;
		const range = selection.getRangeAt(0);
		const startElement = closestElement(range.startContainer);
		const endElement = closestElement(range.endContainer);
		if (startElement?.closest("textarea, input, select") || endElement?.closest("textarea, input, select")) {
			return undefined;
		}

		const quote = String(selection).replace(/\s+/g, " ").trim();
		if (quote.length < 2) return undefined;

		const host = closestElement(range.commonAncestorContainer);
		if (!host || host.closest("#canvas-comment-layer")) return undefined;
		if (!host.closest(COMMENT_SCOPE)) return undefined;

		// A selection spanning two slots belongs to neither; reporting the common
		// ancestor would send the agent to patch the wrong section.
		const startSlot = slotNameOf(range.startContainer);
		const endSlot = slotNameOf(range.endContainer);
		const slot = startSlot && startSlot === endSlot ? startSlot : undefined;
		return { quote: quote.slice(0, MAX_QUOTE_CHARS), slot, range: range.cloneRange() };
	}

	function slotNameOf(node) {
		const element = closestElement(node)?.closest("[data-canvas-slot]");
		return element?.getAttribute("data-canvas-slot") || undefined;
	}

	function positionCommentUi(element, range) {
		let rect;
		try {
			rect = range.getBoundingClientRect();
		} catch {
			rect = undefined;
		}
		const margin = 8;
		const viewportWidth = document.documentElement?.clientWidth ?? 0;
		const viewportHeight = document.documentElement?.clientHeight ?? 0;
		const width = element.offsetWidth || 0;
		const height = element.offsetHeight || 0;
		let top = (rect?.bottom ?? 0) + window.scrollY + margin;
		if (height > 0 && viewportHeight > 0 && (rect?.bottom ?? 0) + margin + height > viewportHeight) {
			top = (rect?.top ?? 0) + window.scrollY - height - margin;
		}
		let left = (rect?.left ?? 0) + window.scrollX;
		if (width > 0 && viewportWidth > 0) {
			left = Math.min(left, window.scrollX + viewportWidth - width - margin);
		}
		element.style.top = `${Math.max(top, margin)}px`;
		element.style.left = `${Math.max(left, margin)}px`;
	}

	function onSelectionSettled() {
		if (commentComposer && !commentComposer.hidden) return;
		const selected = readSelection();
		if (!selected) {
			if (commentPill) commentPill.hidden = true;
			pendingComment = undefined;
			return;
		}
		buildCommentLayer();
		pendingComment = selected;
		commentPill.hidden = false;
		positionCommentUi(commentPill, selected.range);
	}

	function openCommentComposer() {
		if (!pendingComment) return;
		buildCommentLayer();
		commentPill.hidden = true;
		commentQuote.textContent = pendingComment.quote;
		commentInput.value = "";
		commentComposer.hidden = false;
		positionCommentUi(commentComposer, pendingComment.range);
		commentInput.focus?.();
	}

	function closeCommentUi() {
		pendingComment = undefined;
		if (!commentLayer) return;
		commentPill.hidden = true;
		commentComposer.hidden = true;
		commentInput.value = "";
	}

	function showCommentToast(message) {
		if (!commentLayer) return;
		const toast = commentLayer.querySelector(".canvas-comment-toast");
		if (!toast) return;
		toast.textContent = message;
		toast.hidden = false;
		clearTimeout(commentToastTimer);
		commentToastTimer = window.setTimeout(() => {
			toast.hidden = true;
		}, 2400);
	}

	function submitComment() {
		if (!pendingComment) return;
		const note = (commentInput?.value ?? "").trim();
		if (!note) {
			commentInput?.focus?.();
			return;
		}

		const range = pendingComment.range;
		const payload = { quote: pendingComment.quote, note };
		if (pendingComment.slot) payload.slot = pendingComment.slot;

		closeCommentUi();
		showCommentToast("Sending comment…");

		// The server assigns the index and owns the log, so success is only known
		// once it answers; highlighting earlier would claim a comment that failed.
		postJson("/comment", payload, (ok, body) => {
			if (!ok) {
				showCommentToast("Comment failed to send");
				return;
			}
			commentRanges.push(range);
			if (commentRanges.length > MAX_HIGHLIGHTS) commentRanges.splice(0, commentRanges.length - MAX_HIGHLIGHTS);
			refreshCommentHighlights();
			showCommentToast(body?.delivered === false ? "Comment saved but not delivered" : "Comment sent to Pi");
		});
		pokePoll();
	}

	// Ranges are live: removing the quoted nodes does not detach the range, it
	// collapses onto the surviving parent. So staleness is "the range no longer
	// covers text", not "its containers left the document".
	function isRangeLive(range) {
		if (!range || range.collapsed) return false;
		if (!range.startContainer?.isConnected || !range.endContainer?.isConnected) return false;
		return String(range).trim().length > 0;
	}

	// A patch can replace the very text the open composer quotes; sending then
	// would cite content the page no longer shows.
	function refreshPendingComment() {
		if (!pendingComment || isRangeLive(pendingComment.range)) return;
		closeCommentUi();
		showCommentToast("Selection changed");
	}

	// CSS Custom Highlight API keeps commented passages marked without mutating
	// agent-rendered DOM (wrapping nodes would break the next targeted patch).
	function refreshCommentHighlights() {
		if (commentRanges.length === 0) return;
		const live = commentRanges.filter(isRangeLive);
		commentRanges.length = 0;
		commentRanges.push(...live);

		try {
			const registry = window.CSS?.highlights;
			if (!registry || typeof window.Highlight !== "function") return;
			if (live.length === 0) {
				registry.delete("canvas-comment");
				return;
			}
			registry.set("canvas-comment", new window.Highlight(...live));
		} catch {
			// Highlight API unavailable: comments still reach the agent.
		}
	}

	document.addEventListener("mouseup", () => {
		window.setTimeout(onSelectionSettled, 0);
	});

	document.addEventListener("keydown", (event) => {
		if (event.key !== "Escape") return;
		const composerVisible = commentComposer && !commentComposer.hidden;
		const pillVisible = commentPill && !commentPill.hidden;
		if (!composerVisible && !pillVisible) return;
		event.preventDefault();
		closeCommentUi();
	});

	document.addEventListener("keyup", (event) => {
		if (!event.shiftKey && event.key !== "Shift") return;
		window.setTimeout(onSelectionSettled, 0);
	});

	document.addEventListener("selectionchange", () => {
		if (commentComposer && !commentComposer.hidden) return;
		window.setTimeout(onSelectionSettled, 0);
	});

	document.addEventListener("mousedown", (event) => {
		const target = event.target;
		if (target instanceof Element && target.closest("#canvas-comment-layer")) return;
		if (commentComposer && !commentComposer.hidden) closeCommentUi();
	});

	connectStream();
	pollLoop();
})();
