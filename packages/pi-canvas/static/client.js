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

	function schedulePoll(delay) {
		clearTimeout(pollTimer);
		pollTimer = window.setTimeout(pollLoop, delay);
	}

	function pollLoop() {
		pollPatches();
		schedulePoll(pollDelay);
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
				for (const patch of patches) {
					if (typeof patch?.id === "number") afterId = Math.max(afterId, patch.id);
					applyPatch(patch);
				}
				if (patches.length > 0) {
					// Activity: poll fast and reschedule immediately.
					pollDelay = MIN_POLL_MS;
					schedulePoll(MIN_POLL_MS);
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
		// Local interaction likely triggers a server-side patch; poll soon.
		pollDelay = MIN_POLL_MS;
		schedulePoll(MIN_POLL_MS);
	}

	function postJson(pathname, payload) {
		const request = new XMLHttpRequest();
		request.open("POST", `${pathname}?token=${encodeURIComponent(token)}`);
		request.setRequestHeader("content-type", "application/json");
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
		syncSignals();
	}, true);

	document.addEventListener("change", (event) => {
		if (!maybeCaptureSignal(event.target)) return;
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

	pollLoop();
})();
