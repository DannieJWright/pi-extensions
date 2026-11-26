import type { ElementSnapshot } from "./steps.ts";

// Self-contained so a Playwright driver can pass it directly to page.evaluate.
export function inspectDom(input: { selector: string; fields: string[] }): ElementSnapshot[] {
	return Array.from(document.querySelectorAll(input.selector), element => {
		const result: ElementSnapshot = {};
		for (const field of input.fields) {
			if (field === "box") {
				const rect = element.getBoundingClientRect();
				result.box = { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
			} else if (field === "text") result.text = element.textContent;
			else if (field.startsWith("computed:")) {
				const name = field.slice(9), style = getComputedStyle(element);
				const property = name.startsWith("--") || name.includes("-") ? style.getPropertyValue(name) : style[name as keyof CSSStyleDeclaration];
				(result.computed ??= {})[name] = property || null;
			} else {
				const name = field.startsWith("attribute:") ? field.slice(10) : field;
				(result.attributes ??= {})[name] = element.getAttribute(name);
			}
		}
		return result;
	});
}
