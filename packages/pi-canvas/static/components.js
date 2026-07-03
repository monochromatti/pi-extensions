(() => {
	// Webfonts load after first paint so an offline or slow CDN never blocks
	// the canvas; fallback stacks in styles.css cover the gap.
	function loadFontsStylesheet() {
		const link = document.createElement("link");
		link.rel = "stylesheet";
		link.href = "/fonts.css";
		document.head.appendChild(link);
	}

	if (document.readyState === "complete") {
		loadFontsStylesheet();
	} else {
		window.addEventListener("load", loadFontsStylesheet, { once: true });
	}

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
					const prefersDark = typeof window.matchMedia === "function" && window.matchMedia("(prefers-color-scheme: dark)").matches;
					mermaid.initialize({
						startOnLoad: false,
						securityLevel: "strict",
						theme: prefersDark ? "dark" : "neutral",
					});
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

	const MARKED_VERSION = "12.0.2";
	const MARKED_SRC = `https://cdn.jsdelivr.net/npm/marked@${MARKED_VERSION}/marked.min.js`;
	let markedLoadPromise;

	function getMarkedApi() {
		const existing = globalThis.marked;
		if (existing && typeof existing.parse === "function") {
			return Promise.resolve(existing);
		}

		if (!markedLoadPromise) {
			markedLoadPromise = new Promise((resolve) => {
				try {
					const script = document.createElement("script");
					script.src = MARKED_SRC;
					script.async = true;
					script.crossOrigin = "anonymous";
					script.dataset.piCanvasMarked = "1";
					script.onload = () => {
						const api = globalThis.marked;
						resolve(api && typeof api.parse === "function" ? api : null);
					};
					script.onerror = () => resolve(null);
					document.head.appendChild(script);
				} catch {
					resolve(null);
				}
			});
		}

		return markedLoadPromise;
	}

	const MARKDOWN_BLOCKED_TAGS = new Set([
		"script",
		"style",
		"iframe",
		"object",
		"embed",
		"link",
		"meta",
		"base",
		"form",
	]);

	// Mirrors the server-side sanitizer rules for HTML that marked re-derives
	// from markdown source (raw HTML passthrough, javascript: links, inline
	// handlers). CSP is the backstop for asset origins.
	function sanitizeMarkdownFragment(root) {
		const elements = [...root.querySelectorAll("*")];
		for (const element of elements) {
			if (MARKDOWN_BLOCKED_TAGS.has(element.localName)) {
				element.remove();
				continue;
			}
			for (const attribute of [...element.attributes]) {
				const name = attribute.name.toLowerCase();
				if (name.startsWith("on") || name === "style" || name === "srcdoc") {
					element.removeAttribute(attribute.name);
					continue;
				}
				if (name === "href" || name === "src" || name === "xlink:href") {
					const value = attribute.value.replace(/[\u0000-\u0020]+/g, "").toLowerCase();
					if (value.startsWith("javascript:") || value.startsWith("data:text/html")) {
						element.removeAttribute(attribute.name);
					}
				}
			}
		}
	}

	class MarkdownBlockElement extends HTMLElement {
		connectedCallback() {
			void this.render();
		}

		async render() {
			const source = this.textContent || "";

			this.replaceChildren();
			this.classList.add("markdown-block");

			const body = document.createElement("div");
			body.className = "markdown-body";
			this.appendChild(body);

			const marked = await getMarkedApi();
			if (!this.isConnected) return;

			if (!marked || typeof marked.parse !== "function") {
				const fallback = document.createElement("pre");
				fallback.className = "markdown-fallback";
				fallback.textContent = source;
				body.replaceChildren(fallback);
				return;
			}

			try {
				const html = marked.parse(source, { async: false, gfm: true, breaks: false });
				const parsed = new DOMParser().parseFromString(typeof html === "string" ? html : "", "text/html");
				sanitizeMarkdownFragment(parsed.body);
				body.replaceChildren(...parsed.body.childNodes);
			} catch {
				const fallback = document.createElement("pre");
				fallback.className = "markdown-fallback";
				fallback.textContent = source;
				body.replaceChildren(fallback);
			}
		}
	}

	if (!customElements.get("code-block")) {
		customElements.define("code-block", CodeBlockElement);
	}

	if (!customElements.get("mermaid-diagram")) {
		customElements.define("mermaid-diagram", MermaidDiagramElement);
	}

	if (!customElements.get("markdown-block")) {
		customElements.define("markdown-block", MarkdownBlockElement);
	}
})();
