(() => {
	function classifyDiffLine(line) {
		if (line.startsWith("+")) return "diff-add";
		if (line.startsWith("-")) return "diff-del";
		return "diff-ctx";
	}

	function maybeTransformLine(language, line) {
		const hook = globalThis.piCanvasCodeBlockTransformLine;
		if (typeof hook !== "function") return line;
		try {
			const transformed = hook({ language, line });
			return typeof transformed === "string" ? transformed : line;
		} catch {
			return line;
		}
	}

	class CodeBlockElement extends HTMLElement {
		connectedCallback() {
			this.render();
		}

		render() {
			const language = (this.getAttribute("language") || "text").toLowerCase();
			const raw = this.textContent || "";
			const lines = raw.split("\n");

			this.replaceChildren();
			this.classList.add("code-block");

			const shell = document.createElement("div");
			shell.className = "code-block-shell";

			const toolbar = document.createElement("div");
			toolbar.className = "code-toolbar";

			const lang = document.createElement("span");
			lang.className = "code-language";
			lang.textContent = language;
			toolbar.appendChild(lang);

			const copyButton = document.createElement("button");
			copyButton.type = "button";
			copyButton.className = "copy-button";
			copyButton.textContent = "Copy";
			copyButton.addEventListener("click", async () => {
				try {
					if (navigator.clipboard?.writeText) {
						await navigator.clipboard.writeText(raw);
					}
				} catch {
					// noop
				}
				copyButton.setAttribute("data-copied", "true");
				setTimeout(() => copyButton.removeAttribute("data-copied"), 600);
			});
			toolbar.appendChild(copyButton);
			shell.appendChild(toolbar);

			const pre = document.createElement("pre");
			const code = document.createElement("code");
			code.className = `language-${language}`;

			for (let index = 0; index < lines.length; index++) {
				const line = maybeTransformLine(language, lines[index]);
				const lineSpan = document.createElement("span");
				lineSpan.className = "code-line";
				if (language === "diff") {
					lineSpan.classList.add(classifyDiffLine(line));
				}
				lineSpan.textContent = line;
				code.appendChild(lineSpan);
				if (index < lines.length - 1) {
					code.appendChild(document.createTextNode("\n"));
				}
			}

			pre.appendChild(code);
			shell.appendChild(pre);
			this.appendChild(shell);
		}
	}

	const MERMAID_VERSION = "11.4.1";
	const MERMAID_SRC = `https://cdn.jsdelivr.net/npm/mermaid@${MERMAID_VERSION}/dist/mermaid.min.js`;
	let mermaidLoadPromise;
	let mermaidInitialized = false;
	let mermaidSequence = 1;

	function getMermaidApi() {
		const existing = globalThis.mermaid;
		if (existing && typeof existing.render === "function") {
			return Promise.resolve(existing);
		}

		if (!mermaidLoadPromise) {
			mermaidLoadPromise = new Promise((resolve) => {
				try {
					const script = document.createElement("script");
					script.src = MERMAID_SRC;
					script.async = true;
					script.crossOrigin = "anonymous";
					script.dataset.piCanvasMermaid = "1";
					script.onload = () => {
						const api = globalThis.mermaid;
						resolve(api && typeof api.render === "function" ? api : null);
					};
					script.onerror = () => resolve(null);
					document.head.appendChild(script);
				} catch {
					resolve(null);
				}
			});
		}

		return mermaidLoadPromise;
	}

	class MermaidDiagramElement extends HTMLElement {
		connectedCallback() {
			void this.render();
		}

		async render() {
			const source = (this.textContent || "").trim();

			this.replaceChildren();
			this.classList.add("mermaid-diagram");

			const shell = document.createElement("figure");
			shell.className = "mermaid-shell";

			const caption = document.createElement("figcaption");
			caption.className = "muted";
			caption.textContent = "Mermaid diagram";
			shell.appendChild(caption);

			const container = document.createElement("div");
			container.className = "mermaid-container";
			container.textContent = source;
			shell.appendChild(container);

			const error = document.createElement("p");
			error.className = "mermaid-error warning";
			error.hidden = true;
			shell.appendChild(error);

			this.appendChild(shell);

			const mermaid = await getMermaidApi();
			if (!this.isConnected) return;

			if (!mermaid || typeof mermaid.render !== "function") {
				error.hidden = false;
				error.textContent = "Mermaid unavailable. Showing source text.";
				return;
			}

			try {
				if (!mermaidInitialized && typeof mermaid.initialize === "function") {
					mermaid.initialize({ startOnLoad: false, securityLevel: "strict" });
					mermaidInitialized = true;
				}

				const renderId = `pi-canvas-mermaid-${mermaidSequence++}`;
				const output = await mermaid.render(renderId, source || "graph TD\nA[empty]-->B[empty]");
				if (!this.isConnected) return;
				const svg = typeof output === "string" ? output : output?.svg;
				if (typeof svg !== "string" || svg.length === 0) {
					throw new Error("render failed");
				}

				container.innerHTML = svg;
			} catch (cause) {
				error.hidden = false;
				error.textContent = `Mermaid render failed: ${cause instanceof Error ? cause.message : "unknown error"}`;
				container.textContent = source;
			}
		}
	}

	if (!customElements.get("code-block")) {
		customElements.define("code-block", CodeBlockElement);
	}

	if (!customElements.get("mermaid-diagram")) {
		customElements.define("mermaid-diagram", MermaidDiagramElement);
	}
})();
