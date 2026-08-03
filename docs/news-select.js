(() => {
  const instances = new WeakMap();
  const activeInstances = new Set();

  function enhance(select) {
    const existing = instances.get(select);
    if (existing) {
      existing.refresh();
      return existing;
    }

    const root = document.createElement("div");
    root.className = "news-select";
    select.parentNode.insertBefore(root, select);
    root.appendChild(select);

    select.classList.add("news-select-native");
    select.tabIndex = -1;
    select.setAttribute("aria-hidden", "true");

    const trigger = document.createElement("button");
    trigger.className = "news-select-trigger";
    trigger.type = "button";
    trigger.setAttribute("aria-haspopup", "listbox");
    trigger.setAttribute("aria-expanded", "false");
    trigger.setAttribute("aria-label", select.getAttribute("aria-label") || "打开选项");

    const valueLabel = document.createElement("span");
    valueLabel.className = "news-select-value";
    trigger.appendChild(valueLabel);

    const menu = document.createElement("div");
    menu.className = "news-select-menu";
    menu.setAttribute("role", "listbox");
    menu.setAttribute("aria-label", select.getAttribute("aria-label") || "选择选项");
    menu.setAttribute("aria-hidden", "true");

    root.append(trigger, menu);

    let optionButtons = [];

    function close({ restoreFocus = false } = {}) {
      root.classList.remove("open");
      trigger.setAttribute("aria-expanded", "false");
      menu.setAttribute("aria-hidden", "true");
      if (restoreFocus) trigger.focus();
    }

    function closeOthers() {
      for (const instance of activeInstances) {
        if (instance.root !== root) instance.close();
      }
    }

    function selectedIndex() {
      return Math.max(
        0,
        optionButtons.findIndex((button) => button.dataset.value === select.value)
      );
    }

    function focusOption(index) {
      if (!optionButtons.length) return;
      const nextIndex = (index + optionButtons.length) % optionButtons.length;
      optionButtons[nextIndex].focus();
    }

    function open(focusSelected = false) {
      closeOthers();
      root.classList.add("open");
      trigger.setAttribute("aria-expanded", "true");
      menu.setAttribute("aria-hidden", "false");
      if (focusSelected) requestAnimationFrame(() => focusOption(selectedIndex()));
    }

    function choose(value) {
      select.value = value;
      select.dispatchEvent(new Event("change", { bubbles: true }));
      refreshSelection();
      close({ restoreFocus: true });
    }

    function refreshSelection() {
      const selected = select.selectedOptions[0];
      valueLabel.textContent = selected?.textContent || "请选择";
      for (const button of optionButtons) {
        const isSelected = button.dataset.value === select.value;
        button.classList.toggle("selected", isSelected);
        button.setAttribute("aria-selected", String(isSelected));
      }
    }

    function onOptionKeydown(event, index) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        focusOption(index + 1);
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        focusOption(index - 1);
      } else if (event.key === "Home") {
        event.preventDefault();
        focusOption(0);
      } else if (event.key === "End") {
        event.preventDefault();
        focusOption(optionButtons.length - 1);
      } else if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        choose(optionButtons[index].dataset.value);
      } else if (event.key === "Escape") {
        event.preventDefault();
        close({ restoreFocus: true });
      } else if (event.key === "Tab") {
        close();
      }
    }

    function refresh() {
      menu.replaceChildren();
      optionButtons = Array.from(select.options).map((option, index) => {
        const button = document.createElement("button");
        button.className = "news-select-option";
        button.type = "button";
        button.tabIndex = -1;
        button.dataset.value = option.value;
        button.setAttribute("role", "option");
        button.textContent = option.textContent;
        button.addEventListener("click", () => choose(option.value));
        button.addEventListener("keydown", (event) => onOptionKeydown(event, index));
        menu.appendChild(button);
        return button;
      });
      refreshSelection();
    }

    trigger.addEventListener("click", () => {
      if (root.classList.contains("open")) close();
      else open();
    });
    trigger.addEventListener("keydown", (event) => {
      if (["ArrowDown", "ArrowUp", "Enter", " "].includes(event.key)) {
        event.preventDefault();
        open(true);
      } else if (event.key === "Escape") {
        close();
      }
    });
    select.addEventListener("change", refreshSelection);
    document.addEventListener("click", (event) => {
      if (!root.contains(event.target)) close();
    });

    const instance = { root, close, open, refresh };
    instances.set(select, instance);
    activeInstances.add(instance);
    refresh();
    return instance;
  }

  window.NewsSelect = { enhance };
})();
