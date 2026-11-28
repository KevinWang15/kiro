// A filter bar of tokens. Each token is a field, a condition and values,
// written one step at a time from a list under the caret: pick a field, then
// how it matches, then its values. Clicking a token edits it, its × removes it,
// and Backspace in the empty field steps back through the last one. A token
// takes effect as soon as it is complete.
//
// The host says what can be filtered and owns the tokens:
//   fields()              the fields, each { name, title, icon, detail, input,
//                         operators, unique, choices, typed }
//   tokens()              the current tokens, each { field, operator, values }
//   onChange(tokens)      called with the new list
//   values(name, others)  resolves to { values: [{ value, count }], truncated }:
//                         what a field holds among the requests the other
//                         tokens match
//   label(name, value)    a value as shown
//   placeholder

// `takes` is how many values a condition needs; "many" toggles values in the
// list until Enter.
export const OPERATORS = {
  is: { id: "is", symbol: "=", description: "is", takes: "one" },
  in: { id: "in", symbol: "is one of", description: "any of several values", takes: "many" },
  not: { id: "not", symbol: "≠", description: "is not", takes: "one" },
  notIn: { id: "notIn", symbol: "is none of", description: "none of several values", takes: "many" },
  gt: { id: "gt", symbol: ">", description: "more than", takes: "one" },
  gte: { id: "gte", symbol: "≥", description: "at least", takes: "one" },
  lt: { id: "lt", symbol: "<", description: "less than", takes: "one" },
  lte: { id: "lte", symbol: "≤", description: "at most", takes: "one" },
  exists: { id: "exists", symbol: "exists", description: "has a value", takes: "none" },
  missing: { id: "missing", symbol: "does not exist", description: "has no value", takes: "none" },
};

// A token as the page URL and the API carry it: field:operator:value,value.
export function encodeToken(token) {
  const values = token.values.map((value) =>
    String(value).replace(/[%,]/g, (char) => encodeURIComponent(char)),
  );
  return [token.field, token.operator, ...(values.length ? [values.join(",")] : [])].join(":");
}

// Null for text that isn't a token. Whether its field and condition exist is
// the caller's to check.
export function decodeToken(text) {
  const [field, operator, ...rest] = String(text).split(":");
  if (!field || !operator) return null;
  const list = rest.join(":");
  try {
    return {
      field,
      operator,
      values: list === "" ? [] : list.split(",").map(decodeURIComponent),
    };
  } catch {
    return null;
  }
}

const NUMBER_PATTERN = /^-?(\d+\.?\d*|\.\d+)$/;
// More rows than this make a list nobody scrolls; typing narrows it.
const LIST_ROWS = 100;
let barCount = 0;

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (name === "class") node.className = value;
    else if (name === "text") node.textContent = value;
    else if (name.startsWith("on")) node.addEventListener(name.slice(2), value);
    else node.setAttribute(name, value === true ? "" : value);
  }
  node.append(...present(children));
  return node;
}

// Children written as `condition && node` leave false behind where there is none.
const present = (children) => children.filter((child) => child || child === 0);

function icon(name) {
  const svg = lucide.createElement(lucide.icons[name] || lucide.icons.Circle);
  svg.setAttribute("stroke-width", "1.7");
  svg.setAttribute("aria-hidden", "true");
  return svg;
}

export function createFilterBar(root, host) {
  const id = `filter-bar-${++barCount}`;
  // The token being written or edited (the one at `index`): its field, then
  // its condition, then its values.
  let draft = null;
  let open = false;
  // The row the arrow keys picked. The pointer never moves it, so Enter means
  // the same thing wherever the mouse happens to rest.
  let highlighted = null;
  // Where the arrows carry on from after a value was toggled. Enter there
  // finishes the token instead of toggling the same value back.
  let resume = null;
  let options = [];
  let optionNodes = [];
  // The values of the field being written, as last fetched.
  let listing = { key: null, items: [], truncated: false, loading: false, error: null };

  const tokenList = el("span", { class: "filter-tokens" });
  const input = el("input", {
    class: "filter-bar-input",
    type: "text",
    role: "combobox",
    autocomplete: "off",
    spellcheck: "false",
    "aria-autocomplete": "list",
    "aria-controls": `${id}-list`,
    "aria-expanded": "false",
  });
  const clear = el(
    "button",
    { class: "filter-bar-clear", type: "button", title: "Clear all", "aria-label": "Clear all filters", hidden: true },
    icon("X"),
  );
  const list = el("div", { class: "filter-list hidden", id: `${id}-list`, role: "listbox" });
  root.classList.add("filter-bar");
  root.setAttribute("role", "group");
  root.setAttribute("aria-label", "Filters");
  root.replaceChildren(icon("ListFilter"), tokenList, input, clear, list);

  const fieldOf = (name) => host.fields().find((field) => field.name === name) || null;
  const operatorOf = (field, operatorId) =>
    field?.operators.find((operator) => operator.id === operatorId) || null;
  const stage = () => (!draft ? "field" : draft.operator === null ? "operator" : "value");
  const draftField = () => (draft ? fieldOf(draft.field) : null);
  const draftOperator = () => operatorOf(draftField(), draft?.operator);
  const titleOf = (name) => fieldOf(name)?.title || name;
  const labelOf = (name, value) => host.label(name, value);
  const editedIndex = () => (draft && draft.index !== null ? draft.index : -1);

  // The tokens with a draft written in: replacing the token it edits, else
  // added. Null while the draft is incomplete. Unchecking every value of a
  // list being edited removes its token.
  function settle(tokens, written) {
    const operator = operatorOf(fieldOf(written.field), written.operator);
    if (!operator) return null;
    const at = written.index ?? -1;
    if (operator.takes !== "none" && written.chosen.length === 0)
      return operator.takes === "many" && at >= 0
        ? tokens.filter((_, index) => index !== at)
        : null;
    const token = {
      field: written.field,
      operator: operator.id,
      values: operator.takes === "none" ? [] : written.chosen,
    };
    return at >= 0
      ? tokens.map((existing, index) => (index === at ? token : existing))
      : [...tokens, token];
  }
  // An edit backed out of leaves the tokens as they were.
  const settled = () => (draft && settle(host.tokens(), draft)) || host.tokens();

  function step(next) {
    draft = next;
    input.value = "";
    highlighted = null;
    resume = null;
  }
  // Tells the host only when the filters differ: settling an edit that
  // changed nothing isn't a change.
  const textOf = (tokens) => tokens.map(encodeToken).join("\n");
  function change(tokens) {
    if (textOf(tokens) !== textOf(host.tokens())) host.onChange(tokens);
  }
  function commit(next) {
    const written = settle(host.tokens(), next);
    step(null);
    if (written) change(written);
    render();
  }
  function finish() {
    const next = settled();
    step(null);
    change(next);
  }
  function edit(token, at) {
    const next = settled();
    change(next);
    const index = next.indexOf(token);
    const takes = operatorOf(fieldOf(token.field), token.operator)?.takes;
    step({
      field: token.field,
      operator: at === "operator" || takes === "none" ? null : token.operator,
      chosen: [...token.values],
      index: index < 0 ? null : index,
    });
    open = true;
    input.focus();
    render();
  }
  function remove(token) {
    const next = settled().filter((existing) => existing !== token);
    step(null);
    change(next);
    render();
  }

  function choose(option) {
    if (option.kind === "field") {
      const existing = option.used
        ? host.tokens().find((token) => token.field === option.field.name)
        : null;
      if (existing) return edit(existing, "value");
      step({ field: option.field.name, operator: null, chosen: [], index: null });
      return render();
    }
    if (option.kind === "operator") {
      const { id: operator, takes } = option.operator;
      const chosen = takes === "one" ? draft.chosen.slice(0, 1) : takes === "none" ? [] : draft.chosen;
      const next = { ...draft, operator, chosen };
      if (takes === "none") return commit(next);
      step(next);
      return render();
    }
    if (draftOperator()?.takes !== "many") return commit({ ...draft, chosen: [option.value] });
    const chosen = draft.chosen.includes(option.value)
      ? draft.chosen.filter((value) => value !== option.value)
      : [...draft.chosen, option.value];
    const at = options.indexOf(option);
    step({ ...draft, chosen });
    resume = at < 0 ? null : at;
    render();
  }

  function back() {
    if (stage() === "value") {
      step({ ...draft, operator: null });
      return render();
    }
    const tokens = host.tokens();
    if (stage() === "operator") {
      // Backing out of the condition takes the token with it.
      const at = editedIndex();
      if (at >= 0) return remove(tokens[at]);
      step(null);
      return render();
    }
    const last = tokens.at(-1);
    if (last) edit(last, "value");
  }

  // Asks the host for the values of the field being written, once per field
  // and set of other filters.
  function loadValues() {
    const field = draftField();
    if (!open || stage() !== "value" || field?.input !== "list") return;
    const others = host.tokens().filter((token) => token.field !== field.name);
    const key = JSON.stringify([field.name, others, host.scope?.()]);
    if (listing.key === key) return;
    listing = { key, items: [], truncated: false, loading: true, error: null };
    host.values(field.name, others).then(
      (result) => {
        if (listing.key !== key) return;
        listing = { key, items: result.values, truncated: result.truncated, loading: false, error: null };
        renderList();
      },
      (error) => {
        if (listing.key !== key) return;
        listing = { ...listing, loading: false, error: error.message };
        renderList();
      },
    );
  }

  // What the list offers at the draft's next step.
  function buildOptions() {
    const text = input.value.trim();
    const needle = text.toLowerCase();
    const tokens = host.tokens();
    if (!draft)
      return host
        .fields()
        .filter(
          (field) =>
            !needle ||
            field.title.toLowerCase().includes(needle) ||
            field.name.toLowerCase().includes(needle),
        )
        .map((field) => ({
          kind: "field",
          field,
          used: field.unique && tokens.some((token) => token.field === field.name),
        }));
    const field = draftField();
    if (!field) return [];
    if (draft.operator === null)
      return field.operators
        .filter(
          (operator) =>
            !needle ||
            operator.symbol.toLowerCase().includes(needle) ||
            operator.description.includes(needle),
        )
        .map((operator) => ({ kind: "operator", operator }));
    if (field.input === "number")
      return NUMBER_PATTERN.test(text) ? [{ kind: "value", value: text, typed: true }] : [];
    const listed = [
      ...listing.items,
      ...(field.choices || [])
        .filter((value) => !listing.items.some((entry) => entry.value === value))
        .map((value) => ({ value })),
    ];
    // Values already chosen stay listed, to uncheck them, when the matching
    // requests no longer have them.
    const chosen = draft.chosen
      .filter((value) => !listed.some((entry) => entry.value === value))
      .map((value) => ({ value }));
    const matching = [...chosen, ...listed]
      .filter(
        ({ value }) =>
          !needle || `${value} ${labelOf(field.name, value)}`.toLowerCase().includes(needle),
      )
      .slice(0, LIST_ROWS)
      .map((entry) => ({ kind: "value", value: entry.value, count: entry.count }));
    // Any text can be a value, even one no matching request has.
    if (text && field.typed?.test(text) && !matching.some((option) => option.value === text))
      matching.push({ kind: "value", value: text, typed: true });
    return matching;
  }

  // The row Enter chooses. A list of several values has none until the arrows
  // pick one, so Enter in the empty field finishes the token.
  function activeIndex() {
    if (highlighted !== null && highlighted < options.length) return highlighted;
    if (options.length === 0) return null;
    const finishing =
      draftOperator()?.takes === "many" && draft.chosen.length > 0 && !input.value.trim();
    return finishing ? null : 0;
  }

  function optionRow(option) {
    if (option.kind === "field")
      return [
        icon(option.field.icon),
        el("span", { class: "filter-option-name", text: option.field.title }),
        el("span", { class: "filter-option-detail", text: option.used ? "Edit filter" : option.field.detail }),
      ];
    if (option.kind === "operator")
      return [
        el("span", { class: "filter-option-name filter-option-operator", text: option.operator.symbol }),
        el("span", { class: "filter-option-detail", text: option.operator.description }),
      ];
    const many = draftOperator()?.takes === "many";
    const checked = draft.chosen.includes(option.value);
    return [
      many && el("span", { class: "filter-option-check" }, checked && icon("Check")),
      el("span", {
        class: "filter-option-name",
        text: option.typed ? `Use “${option.value}”` : labelOf(draft.field, option.value),
      }),
      option.count !== undefined &&
        el("span", { class: "filter-option-detail", text: option.count.toLocaleString() }),
    ];
  }

  function renderList() {
    loadValues();
    options = buildOptions();
    const current = stage();
    const field = draftField();
    const many = draftOperator()?.takes === "many";
    const active = activeIndex();
    const prompt =
      current === "field"
        ? "Fields"
        : current === "operator"
          ? `How ${titleOf(draft.field)} matches`
          : `${titleOf(draft.field)} values`;
    const loading = current === "value" && field?.input === "list" && listing.loading;
    const empty =
      current === "field"
        ? "No field matches"
        : current === "operator"
          ? "No such condition"
          : field?.input === "number"
            ? `Type a number${field.detail ? ` (${field.detail})` : ""}`
            : listing.error || "No values in this time range";

    optionNodes = options.map((option, index) =>
      el(
        "div",
        {
          class: `filter-option${index === active ? " active" : ""}`,
          role: "option",
          id: `${id}-option-${index}`,
          "aria-selected": String(option.kind === "value" && draft.chosen.includes(option.value)),
          onclick: () => choose(option),
        },
        ...optionRow(option),
      ),
    );
    list.replaceChildren(
      ...present([
        many && el("div", { class: "filter-list-note", text: "Choose any values, then Enter" }),
        ...optionNodes,
        options.length === 0 &&
          el(
            "div",
            { class: "filter-list-empty" },
            loading && el("span", { class: "spinner xs" }),
            loading ? "Loading values…" : empty,
          ),
        current === "value" &&
          listing.truncated &&
          el("div", { class: "filter-list-note", text: `The ${listing.items.length} most common values` }),
      ]),
    );
    list.setAttribute("aria-label", prompt);
    list.setAttribute("aria-multiselectable", String(many));
    list.classList.toggle("hidden", !open);
    // Under the caret, kept inside the bar's width.
    list.style.left = `${Math.max(0, Math.min(input.offsetLeft, root.clientWidth - list.offsetWidth))}px`;
    input.setAttribute("aria-expanded", String(open));
    input.setAttribute("aria-label", draft ? `${prompt}: type to search` : "Filter: type a field");
    if (open && active !== null) input.setAttribute("aria-activedescendant", `${id}-option-${active}`);
    else input.removeAttribute("aria-activedescendant");
    input.inputMode = current === "value" && field?.input === "number" ? "decimal" : "text";
  }

  function tokenNode(token) {
    const field = fieldOf(token.field);
    const title = titleOf(token.field);
    const symbol = operatorOf(field, token.operator)?.symbol || token.operator;
    const shown = token.values.map((value) => labelOf(token.field, value)).join(", ");
    return el(
      "span",
      { class: "filter-token" },
      el("span", { class: "filter-token-field", text: title, onclick: () => edit(token, "value") }),
      el("span", { class: "filter-token-operator", text: symbol, onclick: () => edit(token, "operator") }),
      shown &&
        el("button", {
          class: "filter-token-value",
          type: "button",
          text: shown,
          title: shown,
          "aria-label": `Edit filter ${title} ${symbol} ${shown}`,
          onclick: () => edit(token, "value"),
        }),
      el(
        "button",
        {
          class: "filter-token-remove",
          type: "button",
          "aria-label": `Remove filter ${title} ${symbol} ${shown}`.trim(),
          onclick: () => remove(token),
        },
        icon("X"),
      ),
    );
  }

  function draftNode() {
    const operator = draftOperator();
    const chosen =
      operator?.takes === "many" && draft.chosen.length > 0
        ? draft.chosen.map((value) => labelOf(draft.field, value)).join(", ")
        : "";
    return el(
      "span",
      { class: "filter-token draft", "aria-hidden": "true" },
      el("span", { class: "filter-token-field", text: titleOf(draft.field) }),
      operator && el("span", { class: "filter-token-operator", text: operator.symbol }),
      chosen && el("span", { class: "filter-token-value", text: chosen }),
    );
  }

  function render() {
    const tokens = host.tokens();
    const edited = editedIndex();
    tokenList.replaceChildren(
      ...tokens.filter((_, index) => index !== edited).map(tokenNode),
      ...(draft ? [draftNode()] : []),
    );
    input.placeholder = tokens.length === 0 && !draft ? host.placeholder : "";
    clear.hidden = tokens.length === 0 && !draft;
    renderList();
  }

  function move(delta) {
    if (!open) {
      open = true;
      return renderList();
    }
    if (options.length === 0) return;
    const active = activeIndex() ?? resume;
    highlighted =
      active === null || active >= options.length
        ? delta > 0 ? 0 : options.length - 1
        : (active + delta + options.length) % options.length;
    renderList();
    optionNodes[highlighted]?.scrollIntoView({ block: "nearest" });
  }

  input.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      move(event.key === "ArrowDown" ? 1 : -1);
    } else if (event.key === "Enter") {
      event.preventDefault();
      const active = activeIndex();
      if (open && active !== null) return choose(options[active]);
      if (draft && draftOperator()?.takes === "many" && draft.chosen.length > 0) {
        finish();
        return render();
      }
      open = true;
      renderList();
    } else if (event.key === "Backspace" && input.value === "") {
      event.preventDefault();
      back();
    } else if (event.key === "Escape" && (open || draft)) {
      event.preventDefault();
      event.stopPropagation();
      step(null);
      open = false;
      render();
    }
  });
  input.addEventListener("input", () => {
    highlighted = null;
    resume = null;
    open = true;
    renderList();
  });
  input.addEventListener("focus", () => {
    open = true;
    renderList();
  });
  input.addEventListener("click", () => {
    if (open) return;
    open = true;
    renderList();
  });
  input.addEventListener("blur", () => {
    finish();
    open = false;
    render();
  });
  // Presses inside the bar keep focus in the field, so clicking a token or a
  // list row isn't leaving it; a press on the bar's own background goes to
  // the field.
  root.addEventListener("mousedown", (event) => {
    if (event.target === input) return;
    event.preventDefault();
    if (event.target === root || event.target === tokenList) input.focus();
  });
  clear.addEventListener("click", () => {
    step(null);
    change([]);
    render();
  });

  render();
  return {
    // Shows the host's tokens again after they changed outside the bar.
    render,
    // Drops a token half written, for when the page it filters is replaced.
    reset() {
      step(null);
      open = false;
      listing = { key: null, items: [], truncated: false, loading: false, error: null };
      render();
    },
  };
}
