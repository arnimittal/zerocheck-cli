/** Fixed native DOM observations. Serialized only into Playwright's isolated world.
 * No page/model code or configured expected secret is accepted as an operation. */
export const facts = {
  /** Bounded observation preparation, not an authored action. Never scroll a
   * hidden/clip axis: scrollIntoView would expose intentionally hidden content. */
  revealForObservation: (target: any): boolean => {
    if (!target.isConnected) throw new Error('Text target detached during observation.');
    const win = target.ownerDocument.defaultView;
    const ancestors: any[] = [];
    for (let node = target; node; node = node.parentElement ?? node.getRootNode()?.host) {
      const style = win.getComputedStyle(node);
      if (style.display === 'none' || style.visibility !== 'visible' || Number(style.opacity) === 0 || style.contentVisibility === 'hidden') return false;
      ancestors.push(node);
    }
    let moved = false;
    for (const node of ancestors.slice(1)) {
      if (['HTML', 'BODY'].includes(node.tagName)) continue; // Document below-fold semantics stay unchanged.
      const style = win.getComputedStyle(node), box = node.getBoundingClientRect(), rect = target.getBoundingClientRect();
      const left = box.left + node.clientLeft, top = box.top + node.clientTop;
      const x = rect.left < left ? rect.left - left : Math.max(0, rect.right - left - node.clientWidth);
      const y = rect.top < top ? rect.top - top : Math.max(0, rect.bottom - top - node.clientHeight);
      const beforeX = node.scrollLeft, beforeY = node.scrollTop;
      const scrollX = /^(auto|scroll)$/.test(style.overflowX) && node.scrollWidth > node.clientWidth;
      const scrollY = /^(auto|scroll)$/.test(style.overflowY) && node.scrollHeight > node.clientHeight;
      if (scrollX && x || scrollY && y) node.scrollTo({ left: beforeX + (scrollX ? x : 0), top: beforeY + (scrollY ? y : 0), behavior: 'instant' });
      moved ||= node.scrollLeft !== beforeX || node.scrollTop !== beforeY;
    }
    return moved;
  },
  /** Native geometry shared by text and embedded-frame observations. Partial
   * clipping cannot establish a complete text node or a frame's contents. */
  perceptibleBounds: (node: any, suppliedRect?: any): 'visible' | 'hidden' | 'partial' => {
    if (!node.isConnected) throw new Error('Text target detached during observation.');
    const doc = node.ownerDocument, win = doc.defaultView, box = node.getBoundingClientRect();
    const rect = suppliedRect ?? { left: box.left + node.clientLeft, top: box.top + node.clientTop, right: box.left + node.clientLeft + node.clientWidth, bottom: box.top + node.clientTop + node.clientHeight };
    let left = Math.max(rect.left, -win.scrollX), top = Math.max(rect.top, -win.scrollY);
    let right = Math.min(rect.right, Math.max(doc.documentElement.scrollWidth, win.innerWidth) - win.scrollX);
    let bottom = Math.min(rect.bottom, Math.max(doc.documentElement.scrollHeight, win.innerHeight) - win.scrollY);
    for (let el = node; el; el = el.parentElement ?? el.getRootNode()?.host) {
      const style = win.getComputedStyle(el), box = el.getBoundingClientRect();
      if (style.display === 'none' || style.visibility !== 'visible' || Number(style.opacity) === 0 || style.contentVisibility === 'hidden') return 'hidden';
      if (/(?:hidden|clip|scroll|auto)/.test(style.overflowX) && !['HTML','BODY'].includes(el.tagName)) { left = Math.max(left, box.left + el.clientLeft); right = Math.min(right, box.left + el.clientLeft + el.clientWidth); }
      if (/(?:hidden|clip|scroll|auto)/.test(style.overflowY) && !['HTML','BODY'].includes(el.tagName)) { top = Math.max(top, box.top + el.clientTop); bottom = Math.min(bottom, box.top + el.clientTop + el.clientHeight); }
      if (style.clip !== 'auto' && /^(?:absolute|fixed)$/.test(style.position)) {
        const clip = style.clip.match(/^rect\(([^)]+)\)$/);
        if (!clip) throw new Error('Text clipping could not be inspected.');
        const values = clip[1].split(/[,\s]+/).map((value: string, index: number) => value === 'auto' ? [0, box.width, box.height, 0][index] : parseFloat(value));
        if (values.length !== 4 || values.some((value: number) => !Number.isFinite(value))) throw new Error('Text clipping could not be inspected.');
        top = Math.max(top, box.top + values[0]); right = Math.min(right, box.left + values[1]); bottom = Math.min(bottom, box.top + values[2]); left = Math.max(left, box.left + values[3]);
      }
      if (style.clipPath !== 'none') {
        const inset = style.clipPath.match(/^inset\(([^)]+)\)$/);
        if (!inset || /\bround\b/.test(inset[1])) throw new Error('Text clipping shape could not be inspected.');
        const values = inset[1].trim().split(/\s+/);
        if (values.some((value: string) => !/^-?[\d.]+(?:px|%)?$/.test(value))) throw new Error('Text clipping shape could not be inspected.');
        const four = [values[0], values[1] ?? values[0], values[2] ?? values[0], values[3] ?? values[1] ?? values[0]];
        const px = four.map((value: string, index: number) => parseFloat(value) * (value.endsWith('%') ? (index % 2 ? box.width : box.height) / 100 : 1));
        top = Math.max(top, box.top + px[0]); right = Math.min(right, box.right - px[1]); bottom = Math.min(bottom, box.bottom - px[2]); left = Math.max(left, box.left + px[3]);
      }
      if (right <= left || bottom <= top) return 'hidden';
    }
    if (right <= left || bottom <= top) return 'hidden';
    return left <= rect.left + 0.5 && top <= rect.top + 0.5 && right >= rect.right - 0.5 && bottom >= rect.bottom - 0.5 ? 'visible' : 'partial';
  },
  /** Expected strings stay in Node; document coordinates preserve below-fold content. */
  perceptibleText: (root: any, _input: undefined, nativeFacts: { perceptibleBounds(node: any, rect?: any): 'visible' | 'hidden' | 'partial' }): string => {
    if (!root.isConnected) throw new Error('Text target detached during observation.');
    const doc = root.ownerDocument, win = doc.defaultView;
    const parts: string[] = [];
    const helpers = {
      visit(node: any): void {
        if (node.nodeType === 3) {
          if (!node.textContent) return;
          const range = doc.createRange(); range.selectNodeContents(node);
          const rects = Array.from(range.getClientRects()) as any[];
          const parent = node.parentElement, style = win.getComputedStyle(parent);
          // A DOM Range includes font leading outside a normal line-height:1
          // box. Normalize only this simple owning line, never horizontal
          // clipping, a smaller-than-line box, ancestor clips or frame bounds.
          const lineHeight = parseFloat(style.lineHeight), fontSize = parseFloat(style.fontSize);
          let plain = rects.length === 1 && parent.childElementCount === 0 && style.writingMode === 'horizontal-tb'
            && style.clip === 'auto' && style.clipPath === 'none' && lineHeight >= fontSize;
          for (let owner = parent; plain && owner; owner = owner.parentElement ?? owner.getRootNode()?.host) {
            const outer = win.getComputedStyle(owner);
            if (outer.transform !== 'none' || outer.zoom !== '1') plain = false;
          }
          const box = parent.getBoundingClientRect();
          const contentTop = box.top + parent.clientTop + parseFloat(style.paddingTop);
          const contentHeight = parent.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
          const states = rects.map(rect => nativeFacts.perceptibleBounds(parent,
            plain && contentHeight >= lineHeight && rect.height >= lineHeight
              ? { left: rect.left, right: rect.right, top: Math.max(rect.top, contentTop), bottom: Math.min(rect.bottom, contentTop + contentHeight) }
              : rect));
          if (states.includes('partial') || states.includes('visible') && states.includes('hidden')) throw new Error('Partly clipped text is inconclusive.');
          if (states.length && states.every(state => state === 'visible')) parts.push(node.textContent);
          return;
        }
        if (node.nodeType !== 1 || /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(node.tagName)) return;
        if (node.tagName === 'INPUT' && /^(button|submit|reset)$/.test(node.type)) {
          const state = nativeFacts.perceptibleBounds(node);
          if (state === 'partial') throw new Error('Partly clipped control text is inconclusive.');
          if (state === 'visible') parts.push(node.value); return;
        }
        const block = !/^(?:inline|contents)/.test(win.getComputedStyle(node).display);
        if (block || node.tagName === 'BR') parts.push('\n');
        for (const child of node.childNodes) helpers.visit(child);
        if (block) parts.push('\n');
      },
    };
    helpers.visit(root);
    return parts.join('').replace(/\s+/g, ' ').trim();
  },

  controlReadiness: (root: any) => {
    const doc = root.ownerDocument || root, controls: unknown[] = [];
    const visit = { tree(scope: any): void {
      for (const el of scope.querySelectorAll('*')) {
        if (el.matches('button,input,select,textarea,a[href],[role="button"],[role="link"],[role="checkbox"],[role="radio"],[role="combobox"],[role="textbox"]')) {
          const rect = el.getBoundingClientRect(), style = doc.defaultView.getComputedStyle(el);
          if (rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden') controls.push([el.tagName, el.getAttribute('role'), el.getAttribute('aria-label'), el.getAttribute('placeholder'), el.type, el.disabled, el.getAttribute('aria-disabled'), true]);
        }
        if (el.shadowRoot) visit.tree(el.shadowRoot);
      }
    } };
    visit.tree(root); return JSON.stringify(controls);
  },

  connected: (element: any) => Boolean(element.isConnected),
  nodeName: (element: any) => String(element.nodeName),

  visualInspectable: (el: any) => !['CANVAS', 'IFRAME', 'FRAME', 'BODY', 'HTML'].includes(el.tagName),
  labelVisible: (element: any) => {
    const el = element as any;
    if (el.tagName !== 'INPUT' || !['checkbox', 'radio'].includes(el.type)) return false;
    return Array.from(el.labels ?? []).some((label: any) => {
      const rect = label.getBoundingClientRect(); const style = label.ownerDocument.defaultView.getComputedStyle(label);
      return label.control === el && rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden';
    });
  },
  identity: (element: any) => {
    const el = element as any;
    // Keep this browser-serialized callback self-contained. A named local function
    // can acquire an out-of-scope __name helper when tsx preserves function names.
    if (!el.isConnected) return null;
    // Native HTML localName/type are already canonical. Page scripts can wrap
    // String methods, so normalize fallback metadata in Node after this read.
    const tag = el.localName;
    const type = String(el.type || el.getAttribute('type') || '');
    const implicit = el.isContentEditable ? 'textbox' : tag === 'button' ? 'button' : tag === 'a' && el.href ? 'link' : tag === 'select' ? 'combobox' : tag === 'textarea' ? 'textbox' : tag === 'input' ? (['button', 'submit', 'reset', 'image'].includes(type) ? 'button' : type === 'checkbox' ? 'checkbox' : type === 'radio' ? 'radio' : type === 'search' ? 'searchbox' : type === 'number' ? 'spinbutton' : el.list ? 'combobox' : 'textbox') : tag;
    const labelled = String(el.getAttribute('aria-labelledby') || '').trim().split(/\s+/).filter(Boolean).map((id: string) => el.ownerDocument.getElementById(id)?.textContent ?? '').join(' ');
    const labels = Array.from(el.labels ?? []).map((label: any) => { const copy = label.cloneNode(true); for (const control of copy.querySelectorAll('input,select,textarea,button')) control.remove(); return copy.textContent ?? ''; }).join(' ');
    const rawName = el.getAttribute('aria-label') || labelled || labels || el.getAttribute('alt') || (tag === 'input' ? (['button', 'submit', 'reset'].includes(type) ? el.value : el.placeholder) : ['select','textarea'].includes(tag) ? el.placeholder || '' : el.innerText || el.textContent) || el.getAttribute('title');
    let regionLabel = '';
    for (let container = el.parentElement; container && container.tagName !== 'BODY'; container = container.parentElement) {
      const ids = String(container.getAttribute('aria-labelledby') || '').trim().split(/\s+/).filter(Boolean);
      const label = container.getAttribute('aria-label') || ids.map((id: string) => el.ownerDocument.getElementById(id)?.textContent ?? '').join(' ') || container.querySelector(':scope > h1, :scope > h2, :scope > h3, :scope > h4, :scope > [role="heading"], :scope > th[scope="row"], :scope > [role="rowheader"], :scope > legend')?.textContent;
      if (label) { regionLabel = String(label).replace(/\s+/g, ' ').trim(); break; }
    }
    const region = el.closest('form, section, [role="dialog"], [role="region"], article');
    const heading = region?.querySelector('h1,h2,h3,[role="heading"]');
    const rawContext = region?.getAttribute('aria-label') || region?.getAttribute('name') || heading?.textContent;
    // Prefer an explicit record key or row heading over the entire row: status
    // cells and button text may legitimately change without changing the record.
    const row = el.closest('tr, [role="row"], [role="listitem"], [role="treeitem"], li, [data-row-id], [data-record-id], [data-entity-id], [data-item-id]');
    let rawEntity = '';
    if (row) {
      const recordKey = row.getAttribute('data-record-id') || row.getAttribute('data-entity-id') || row.getAttribute('data-row-id') || row.getAttribute('data-item-id');
      const rowLabelIds = String(row.getAttribute('aria-labelledby') || '').trim().split(/\s+/).filter(Boolean);
      const rowLabel = row.getAttribute('aria-label') || rowLabelIds.map((id: string) => el.ownerDocument?.getElementById(id)?.textContent ?? '').join(' ');
      const rowHeading = row.querySelector('[role="rowheader"], th[scope="row"], h1, h2, h3, h4, [role="heading"]');
      const rowLink = row.querySelector('a[href]');
      rawEntity = recordKey ? `key:${recordKey}` : rowLabel ? `label:${rowLabel}` : rowHeading?.textContent ? `heading:${rowHeading.textContent}` : rowLink?.href ? `link:${rowLink.href}` : `text:${row.innerText || row.textContent || ''}`;
    }
    const form = 'form' in el ? el.form : el.closest('form, [role="form"]');
    const fieldset = el.closest('fieldset, [role="group"]');
    const formIds = String(form?.getAttribute('aria-labelledby') || '').trim().split(/\s+/).filter(Boolean);
    const formLabel = form?.getAttribute('aria-label') || formIds.map((id: string) => el.ownerDocument?.getElementById(id)?.textContent ?? '').join(' ') || form?.getAttribute('name') || '';
    const legend = fieldset?.getAttribute('aria-label') || fieldset?.querySelector('legend')?.textContent || '';
    const formParts = form ? [String(formLabel), String(form.action || form.getAttribute('action') || ''), String(form.method || form.getAttribute('method') || 'get'), String(legend)] : legend ? ['', '', '', String(legend)] : [];
    let frameElement: any;
    try { frameElement = el.ownerDocument?.defaultView?.frameElement; } catch { /* A cross-origin owner is represented by its document URL. */ }
    const frameParts = el.ownerDocument?.URL ? [el.ownerDocument.URL, frameElement?.getAttribute('name') || '', frameElement?.getAttribute('title') || '', frameElement?.getAttribute('src') || ''] : [];
    return {
      textEntry: el.isContentEditable || tag === 'textarea' || tag === 'input' && !['button', 'submit', 'reset', 'image', 'checkbox', 'radio', 'file', 'color', 'range', 'hidden'].includes(type),
      roleFromTag: !el.getAttribute('role') && implicit === tag,
      scriptHandlerCandidate: el.tabIndex >= 0,
      interactive: ['button','input','select','textarea','summary'].includes(tag) || tag === 'a' && Boolean(el.href) || Boolean(el.isContentEditable) || implicit !== tag || Boolean(el.getAttribute('role')) || el.tabIndex >= 0 && el.getAttribute('onclick') !== null,
      role: String(el.getAttribute('role') || implicit || ''),
      name: String(rawName || ''),
      inputType: type,
      href: String(el.href || el.getAttribute('href') || ''),
      context: String(rawContext || ''),
      ...(regionLabel ? { regionLabel } : {}),
      ...(rawEntity ? { entity: String(rawEntity) } : {}),
      formParts, frameParts,
    };
  },
  readiness: (element: any, { ownSelectAX = false }: { ownSelectAX?: boolean }) => {
    const el = element as any;
    if (!el.isConnected) return { active: false, moving: false, detached: true };
    const win = el.ownerDocument.defaultView;
    let moving = false;
    for (let node = el; node; node = node.parentElement ?? node.getRootNode()?.host) {
      const style = win.getComputedStyle(node);
      // An invisible native input can still be activated through its own label.
      const ownLabel = node === el && el.localName === 'input' && ['checkbox','radio'].includes(el.type) && el.labels?.length;
      if (node.hasAttribute('inert') || node.getAttribute('aria-hidden') === 'true' && !(ownSelectAX && node === el && el.localName === 'select')
        || !ownLabel && (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0)) return { active: false, moving };
      for (const animation of node.getAnimations?.() ?? []) {
        if (animation.playState !== 'running' && animation.playState !== 'pending') continue;
        const timing = animation.effect?.getComputedTiming();
        // Ignore perpetual decorative animation; finite target/view transitions
        // must finish before dispatch. A fade-out is already an outgoing view.
        if (!timing || !Number.isFinite(timing.endTime)) continue;
        moving = true;
        const frames = animation.effect?.getKeyframes?.() ?? [];
        if (frames.length && Number(frames[frames.length - 1].opacity) === 0) return { active: false, moving: true };
      }
    }
    return { active: true, moving };
  },
  credentialBoundary: (element: any) => {
    const el = element as any;
    const form = 'form' in el ? el.form : el.closest('form');
    const controls = form ? Array.from(form.elements ?? []) : [el];
    const values = controls.map((control: any) => String(control.value ?? (control.isContentEditable ? control.textContent : '') ?? ''));
    const destinations: string[] = [];
    if (el.href) destinations.push(String(el.href));
    if (form) {
      destinations.push(String(el.hasAttribute('formaction') ? el.formAction : form.action || el.ownerDocument.URL));
      // Input can later be submitted by any button owned by this form, including an external form= control.
      for (const control of controls as any[]) if (control.hasAttribute?.('formaction')) destinations.push(String(control.formAction));
    }
    return { values, destinations };
  },
  entityMatch: (element: any, input: { entity?: string; relation?: string; entityPattern: string; ownSurface: boolean; controlName?: string }) => {
          const el = element as any; const doc = el.ownerDocument;
          const entityName = new RegExp(input.entityPattern, 'i');
          const helpers = { normalize(s: string) { return String(s).replace(/\s+/g, ' ').trim(); },
            visible(node: any) { const r = node.getBoundingClientRect(); const s = doc.defaultView.getComputedStyle(node); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; } };
          if (!input.ownSurface && !helpers.visible(el) && !Array.from(el.labels ?? []).some(helpers.visible)) return false;
          if (!input.entity) return true;
          const record = 'article,tr,li,figure,[role="row"],[role="listitem"],[data-record-id],[data-row-id],[data-entity-id],[data-item-id]';
          // A record label owns its control. Mentions nested in prose and labels
          // belonging to another record never establish that relationship.
          for (let container = el.parentElement; container && !['BODY','HTML','MAIN'].includes(container.tagName); container = container.parentElement) {
            if (['root', 'app', '__next'].includes(container.id) || container.getAttribute('role') === 'toolbar') return false;
            // An explicitly named control's own plain wrapping label supplies
            // its name, not a conflicting record. Independent metadata still
            // ends the search normally; role-only intent never enters here.
            const controlRole = el.getAttribute('role');
            const independent = `${record},[data-item-id],[role],[aria-label],[aria-labelledby],section,fieldset,form,dialog,h1,h2,h3,h4,h5,h6,legend,dt,th[scope]`;
            if (input.controlName !== undefined && container.localName === 'label' && container.control === el &&
                !el.matches(`${record},[data-item-id]`) && (!controlRole || /^(?:button|checkbox|radio|switch|textbox|searchbox|combobox|spinbutton)$/i.test(controlRole)) &&
                !container.matches(independent) && !Array.from(container.querySelectorAll(independent)).some(node => node !== el) &&
                helpers.normalize(container.innerText || container.textContent || '').toLowerCase() === input.controlName.toLowerCase()) continue;
            const ids = String(container.getAttribute('aria-labelledby') || '').trim().split(/\s+/).filter(Boolean);
            const labelled = helpers.normalize(container.getAttribute('aria-label') || ids.map((id: string) => doc.getElementById(id)?.textContent || '').join(' '));
            if (labelled && !entityName.test(labelled)) return 'conflict';
            if (labelled && !['next to','beside','under'].includes(input.relation ?? '')) return true;
            const anchors: any[] = [];
            const ownership = { own(node: any) {
              if (node === el || node.contains(el) || el.contains(node) || node.matches(record) || !helpers.visible(node)) return false;
              for (let parent = node.parentElement; parent && parent !== container; parent = parent.parentElement) {
                if (parent.matches(record) || parent.matches('p,blockquote,[role="paragraph"]')) return false;
              }
              return true;
            } };
            // A nested link and its heading represent one name, not two record
            // labels. Prefer the page's own title/row structure over incidental
            // email links, prices and other controls in an action wrapper.
            const heading = 'h1,h2,h3,h4,h5,h6,[role="heading"],th[scope="row"],[role="rowheader"],dt,legend';
            for (const node of Array.from(container.querySelectorAll(heading)) as any[]) if (ownership.own(node) && !anchors.some(anchor => anchor.contains(node))) anchors.push(node);
            const row = container.matches('tr,[role="row"]');
            if (row && !anchors.length) for (const cell of Array.from(container.querySelectorAll('td,[role="cell"],[role="gridcell"]')) as any[]) {
              // Without an explicit row header, retain the leading name cell.
              // Later cells may name related people/products, not this record.
              if (ownership.own(cell) && helpers.normalize(cell.innerText || cell.textContent || '')) { anchors.push(cell); break; }
            }
            if (!anchors.length) for (const node of Array.from(container.querySelectorAll('a[href]')) as any[]) if (ownership.own(node)) anchors.push(node);
            const namedTitles = anchors.length > 0;
            if (!anchors.length) for (const node of Array.from(container.children) as any[]) {
              if (!ownership.own(node) || node.closest('button,input,select,textarea,[role="button"],[role="checkbox"],[role="radio"]')) continue;
              if (node.querySelector('button,input,select,textarea,[role="button"],[role="checkbox"],[role="radio"]')) continue;
              // Preserve an entire name-bearing branch. A nested occurrence in
              // a sentence or in another record cannot become its own title.
              const emphasized = Array.from(node.querySelectorAll('strong,b')) as any[];
              const title = emphasized.length === 1 ? emphasized[0] : undefined;
              if (title && ownership.own(title) && !node.matches('p,blockquote,[role="paragraph"]') &&
                  !node.querySelector(`${record},[role],p,blockquote,a,label`) && !node.hasAttribute('role')) {
                const before = doc.createRange(); before.selectNodeContents(node); before.setEndBefore(title);
                const after = doc.createRange(); after.selectNodeContents(node); after.setStartAfter(title);
                const prefix = helpers.normalize(before.toString()), suffix = helpers.normalize(after.toString());
                // A complete emphasized title followed by numeric metadata is
                // separable; textual prefix/suffix prose remains one whole name.
                if (!prefix && (!suffix || /^(?:\p{Sc}\s*)?\d+(?:[.,]\d+)*(?:\s*\p{Sc})?(?:\s+each)?$/u.test(suffix))) {
                  anchors.push(title); continue;
                }
              }
              if (node.getAttribute('alt') || helpers.normalize(node.innerText || node.textContent || '')) anchors.push(node);
            }
            const directText = helpers.normalize(Array.from(container.childNodes).filter((node: any) => node.nodeType === 3).map((node: any) => node.textContent || '').join(' '));
            const labels = anchors.map(node => ({ node, text: node.getAttribute('alt') || (namedTitles && !row && helpers.normalize(Array.from(node.childNodes).filter((child: any) => child.nodeType === 3).map((child: any) => child.textContent || '').join(' '))) || helpers.normalize(node.innerText || node.textContent || '') }));
            if (directText) labels.unshift({ node: container, text: directText });
            if (!labels.length) {
              if (container.matches(record)) return false;
              continue;
            }
            if (['next to','beside','under'].includes(input.relation ?? '')) {
              const target = el.getBoundingClientRect();
              return labels.some(anchor => { if (!entityName.test(anchor.text)) return false; const r = anchor.node.getBoundingClientRect(); return input.relation === 'under'
                ? target.top >= r.bottom - 2 && Math.min(target.right, r.right) > Math.max(target.left, r.left)
                : Math.min(target.bottom, r.bottom) > Math.max(target.top, r.top) && (target.left >= r.right - 2 || target.right <= r.left + 2); });
            }
            return (row || !namedTitles || labels.length === 1) && labels.some(label => entityName.test(label.text)) ? true : 'conflict';
          }
          return false;
        },
  localLabel: (element: any) => {
    const el = element as any;
    const fields = 'input:not([type="hidden" i],[type="button" i],[type="submit" i],[type="reset" i],[type="checkbox" i],[type="radio" i],[type="file" i],[type="image" i],[type="color" i],[type="range" i]),textarea,[contenteditable=""],[contenteditable="true" i],[contenteditable="plaintext-only" i],[role="textbox"],[role="searchbox"]';
    const owner = el.parentElement;
    if (owner && !owner.matches('form,main,body,html,[role="form"],[role="main"]')) {
      const inputs = Array.from(owner.querySelectorAll(fields));
      if (inputs.length !== 1 || inputs[0] !== el) return '';
      const labels = Array.from(owner.querySelectorAll('label')) as any[];
      if (!labels.length) return Array.from(owner.childNodes).filter((node:any) => node.nodeType === 3).map((node:any) => node.textContent || '').join(' ').replace(/\s+/g,' ').trim();
      if (labels.length !== 1) return '';
      const label = labels[0];
      if (label.parentElement !== owner || label.hasAttribute('for') || label.control && label.control !== el) return '';
      for (let node = label; node; node = node.parentElement) {
        const style = node.ownerDocument.defaultView.getComputedStyle(node);
        if (style.display === 'none' || style.visibility !== 'visible' || Number(style.opacity) === 0) return '';
      }
      const rect = label.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 ? String(label.innerText || '').replace(/\s+/g, ' ').trim() : '';
    }
    return '';
  },
  focusWrapper: (element: any): boolean => element.hasAttribute('tabindex') && !element.isContentEditable
    && !element.matches('button,a[href],input,select,textarea,summary,[role="button"],[role="link"],[role="checkbox"],[role="radio"],[role="switch"],[role="tab"],[role="menuitem"],[role="menuitemcheckbox"],[role="menuitemradio"],[role="option"],[role="combobox"],[role="textbox"],[role="searchbox"],[role="spinbutton"]')
    && !element.hasAttribute('onclick'),
  decorations: (element: any) => {
    const el = element as any;
    const values: string[] = []; const doc = el.ownerDocument;
    for (const node of [el, ...Array.from(el.querySelectorAll('*'))]) for (const pseudo of ['::before', '::after']) values.push(doc.defaultView!.getComputedStyle(node, pseudo).content);
    return values;
  },
  autocomplete: (element: any) => String((element as any).autocomplete ?? ''),
  inputValue: (element: any) => {
    const el = element as any;
    return { connected: el.isConnected && el.ownerDocument === el.ownerDocument.defaultView?.document, tag: el.tagName, type: el.type, autocomplete: String(el.autocomplete ?? ''),
      value: ['INPUT', 'TEXTAREA'].includes(el.tagName) ? el.value : el.isContentEditable ? el.textContent : undefined,
      selectedLabels: el.tagName === 'SELECT' ? Array.from(el.selectedOptions as ArrayLike<{ label: string }>).map(option => option.label) : [] };
  },
  controlState: (element: any) => { const el = element as any; return JSON.stringify({ expanded: el.getAttribute('aria-expanded'), checked: el.getAttribute('aria-checked'), selected: el.getAttribute('aria-selected'), pressed: el.getAttribute('aria-pressed'), nativeChecked: el.tagName === 'INPUT' ? el.checked : null, nonEmptyInput: ['INPUT', 'TEXTAREA'].includes(el.tagName) ? Boolean(el.value) : null }); },
  operationMetadata: (el: any, { activating, implicitSubmitRequested }: { activating?: boolean; implicitSubmitRequested?: boolean }) => {
    const element = el as any;
    const labels = Array.from(element.labels ?? []).map((label: any) => { const copy = label.cloneNode(true); for (const control of copy.querySelectorAll('input,select,textarea,button')) control.remove(); return String(copy.textContent ?? ''); }).join(' ');
    const form = 'form' in element ? element.form : element.closest?.('form') ?? null;
    const formIds = String(form?.getAttribute('aria-labelledby') || '').trim().split(/\s+/).filter(Boolean);
    const formDescriptions = String(form?.getAttribute('aria-describedby') || '').trim().split(/\s+/).filter(Boolean);
    const formPurpose = [form?.getAttribute('aria-label') || formIds.map((id: string) => element.ownerDocument.getElementById(id)?.textContent ?? '').join(' ') || form?.getAttribute('name'), form?.querySelector('legend,h1,h2,h3,h4,h5,h6,[role="heading"]')?.textContent, ...formDescriptions.map((id: string) => element.ownerDocument.getElementById(id)?.textContent ?? '')].filter(Boolean).join(' ');
    const dialog = element.closest('dialog,[role="dialog"],[role="alertdialog"],[aria-modal="true"]');
    const dialogIds = `${dialog?.getAttribute('aria-labelledby') || ''} ${dialog?.getAttribute('aria-describedby') || ''}`.trim().split(/\s+/).filter(Boolean);
    const confirmationContext = dialog ? [dialog.getAttribute('aria-label'), ...dialogIds.map((id: string) => element.ownerDocument.getElementById(id)?.textContent ?? ''), dialog.querySelector('h1,h2,h3,h4,h5,h6,[role="heading"]')?.textContent].filter(Boolean).join(' ') : '';
    const ownSubmit = ['BUTTON', 'INPUT'].includes(element.tagName) && ['submit', 'image'].includes(element.type);
    const implicitSubmit = implicitSubmitRequested && ['INPUT'].includes(element.tagName) && !['checkbox','radio','button','reset'].includes(element.type);
    const isSubmission = Boolean(form && activating && (ownSubmit || implicitSubmit));
    const root = element.getRootNode();
    const submit = isSubmission ? ownSubmit ? element : Array.from((root.documentElement ?? root).querySelectorAll('button,input')).find((control: any) => control.form === form && ['submit','image'].includes(control.type)) as any : undefined;
    const nativeDialogDismissal = Boolean(isSubmission && dialog?.tagName === 'DIALOG' && (submit?.hasAttribute('formmethod') ? submit.formMethod : form?.method) === 'dialog');
    return {
      isSubmission, nativeDialogDismissal,
      submitterName: isSubmission ? String(submit?.getAttribute('aria-label') || submit?.innerText || submit?.value || '') : undefined,
      formAction: isSubmission && !nativeDialogDismissal ? String(submit?.hasAttribute('formaction') ? submit.formAction : form?.action || element.ownerDocument.URL) : undefined,
      optionLabels: (Array.from(element.options ?? []) as any[]).map(option => String(option.label)),
      bulkScope: /\bbulk\b|\ball (?:selected|users|customers|records|items)\b/i.test([labels,element.getAttribute('aria-label'),formPurpose,confirmationContext].filter(Boolean).join(' ')),
      recipientContext: dialog ? Array.from(dialog.querySelectorAll('p,[role="alert"]')).map((node: any) => String(node.textContent ?? '')).join(' ') : '',
      connected: element.isConnected === true,
      role: element.getAttribute('role') || (element.isContentEditable ? 'textbox' : element.tagName === 'BUTTON' ? 'button' : element.tagName === 'A' && element.href ? 'link' : element.tagName === 'SELECT' ? 'combobox' : element.tagName === 'TEXTAREA' ? 'textbox' : element.tagName === 'INPUT' ? ['checkbox','radio'].includes(element.type) ? element.type : ['button','submit','reset','image'].includes(element.type) ? 'button' : element.list ? 'combobox' : 'textbox' : null),
      name: element.getAttribute('aria-label') || String(element.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean).map((id: string) => element.ownerDocument.getElementById(id)?.textContent || '').join(' ') || labels || (element.tagName === 'INPUT' && ['submit','button','reset'].includes(element.type) ? element.value : ['SELECT','TEXTAREA'].includes(element.tagName) ? '' : element.innerText || element.textContent) || element.placeholder || null,
      text: String(['SELECT','TEXTAREA'].includes(element.tagName) ? '' : element.innerText || element.textContent || ''),
      href: element.href ?? element.getAttribute('href'),
      inputType: element.type ?? element.getAttribute('type'),
      labels,
      placeholder: element.placeholder ?? element.getAttribute('placeholder'),
      formPurpose: String(formPurpose),
      confirmationContext: String(confirmationContext),
      inForm: Boolean(form),
      mutationPossible: false,
    };
  },
  ordinalCollectionLabel: (element: any): string => {
    const item = element.closest('li,[role="listitem"],tr,[role="row"],[role="option"],[role="treeitem"]');
    const collection = item?.parentElement?.closest('ol,ul,table,[role="list"],[role="grid"],[role="table"],[role="listbox"],[role="tree"]');
    if (!collection) return '';
    const ids = String(collection.getAttribute('aria-labelledby') || '').trim().split(/\s+/).filter(Boolean);
    return (ids.length ? ids.map((id: string) => collection.ownerDocument.getElementById(id)?.textContent || '').join(' ') : collection.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
  },
  progressState: (element: any) => {
    const el = element as any;
    return { expanded: el.getAttribute('aria-expanded'), checked: el.getAttribute('aria-checked'), selected: el.getAttribute('aria-selected'),
      pressed: el.getAttribute('aria-pressed'), nativeChecked: el.localName === 'input' && ['checkbox', 'radio'].includes(el.type) ? el.checked : null };
  },
  progressBoundary: (element: any): boolean => element.matches('form,article,aside,nav,header,footer,tr,li,[role="form"],[role="dialog"],[role="region"],[role="row"],[role="listitem"],[role="complementary"],[role="navigation"],[role="banner"],[role="contentinfo"],[data-record-id],[data-row-id],[data-entity-id],[data-item-id],[aria-label],[aria-labelledby]'),
  progressView: (scope: any, _input: undefined, nativeFacts: {
    identity(element: any): any; progressBoundary(element: any): boolean;
    perceptibleBounds(element: any): string; perceptibleText(element: any, input: undefined, facts: any): string;
    readiness(element: any, input: { ownSelectAX: boolean }): { active: boolean; moving: boolean };
  }): { fields: string[]; fieldless: boolean; heading?: string; headingLevel?: number; ready: boolean } => {
    if (!scope.isConnected) throw new Error('The active view detached during progress observation.');
    const unknown = { fields: [], fieldless: false, ready: false };
    const owner = nativeFacts.readiness(scope, { ownSelectAX: false });
    if (!owner.active || owner.moving) return unknown;
    const ownership = { owns(node: any): boolean {
      for (let parent = node.parentElement; parent && parent !== scope; parent = parent.parentElement) {
        if (nativeFacts.progressBoundary(parent)) return false;
      }
      return scope.contains(node);
    } };
    const fields: string[] = []; let fieldCount = 0;
    for (const node of scope.querySelectorAll('input:not([type="hidden"],[type="submit"],[type="button"],[type="reset"]),select,textarea,[contenteditable=""],[contenteditable="true" i],[contenteditable="plaintext-only" i],[role="textbox"],[role="searchbox"],[role="spinbutton"],[role="combobox"],[role="checkbox"],[role="radio"],[role="switch"]')) {
      if (!ownership.owns(node)) continue;
      const readiness = nativeFacts.readiness(node, { ownSelectAX: false });
      if (readiness.moving) return unknown;
      if (!readiness.active) continue;
      const visibility = nativeFacts.perceptibleBounds(node);
      if (visibility === 'partial') return unknown;
      if (visibility !== 'visible') continue;
      fieldCount++; // Unnamed, disabled and readonly fields still make this a field-bearing view.
      const identity = nativeFacts.identity(node);
      if (identity?.name) fields.push(JSON.stringify([identity.role, identity.name.replace(/\s+/g, ' ').trim(), identity.inputType]));
    }
    const headings: { node: any; level: number; text: string; eligible: boolean; ready: boolean }[] = [];
    const status = '[role="alert"],[role="status"],[role="log"],[role="timer"],[role="marquee"],[aria-live]:not([aria-live="off"])';
    for (const node of scope.querySelectorAll('h1,h2,h3,h4,h5,h6,[role="heading"]')) {
      if (!ownership.owns(node) || node.parentElement?.closest(status)) continue;
      const readiness = nativeFacts.readiness(node, { ownSelectAX: false });
      if (!readiness.active && !readiness.moving) continue;
      const visibility = nativeFacts.perceptibleBounds(node);
      if (visibility === 'hidden' && !readiness.moving) continue;
      // Keep a disqualified principal in the ranking, without promoting a
      // secondary heading or discarding independent field-turnover evidence.
      const eligible = !node.matches(status) && !node.querySelector(status);
      let text = '', ready = !readiness.moving && visibility === 'visible';
      if (eligible && ready) {
        try { text = nativeFacts.perceptibleText(node, undefined, nativeFacts).replace(/\s+/g, ' ').trim(); }
        catch (error) { if (error instanceof Error && /clipp/.test(error.message)) ready = false; else throw error; }
      }
      headings.push({ node, level: Number(node.getAttribute('aria-level') || node.localName.match(/^h([1-6])$/)?.[1] || 2), text, eligible, ready });
    }
    const labelled = String(scope.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean);
    const explicit = headings.filter(heading => labelled.includes(heading.node.id));
    const principal = labelled.length ? explicit : headings.filter(heading => heading.level === Math.min(...headings.map(candidate => candidate.level)));
    const chosen = principal.length === 1 && principal[0].eligible ? principal[0] : undefined;
    return { fields, fieldless: fieldCount === 0, ready: chosen?.ready ?? true, ...(chosen?.ready && chosen.text ? { heading: chosen.text, headingLevel: chosen.level } : {}) };
  },
};
export const elements = {
  actionDescendants: (element: any) => Array.from(element.querySelectorAll('button,a[href],input,select,textarea,summary,[contenteditable],[role="button"],[role="link"],[role="checkbox"],[role="radio"],[role="switch"],[role="tab"],[role="menuitem"],[role="menuitemcheckbox"],[role="menuitemradio"],[role="option"],[role="combobox"],[role="textbox"],[role="searchbox"],[role="spinbutton"],[tabindex],[onclick]')),
  ordinalItems: (element: any) => {
    const itemSelector = 'li,[role="listitem"],tr,[role="row"],[role="option"],[role="treeitem"]';
    const collectionSelector = 'ol,ul,table,[role="list"],[role="grid"],[role="table"],[role="listbox"],[role="tree"]';
    const item = element.closest(itemSelector);
    const collection = item?.parentElement?.closest(collectionSelector);
    if (!collection) return [];
    // Only the collection's own items participate; nested lists are separate.
    return Array.from(collection.querySelectorAll(itemSelector)).filter((node: any) => {
      if (node.parentElement?.closest(collectionSelector) !== collection) return false;
      for (let parent = node.parentElement; parent && parent !== collection; parent = parent.parentElement) if (parent.matches(itemSelector)) return false;
      return true;
    });
  },
  containingLabel: (control: any) => control.isConnected ? control.closest('label') : null,
  selects: (root: any) => {
    // A native form owns its associated controls, including external form=
    // controls; descendant position is not the ownership relationship.
    if (root.localName === 'form') return Array.from(root.elements).filter((node: any) => node.localName === 'select');
    const nodes: any[] = [];
    const visit = { tree(scope: any): void { for (const node of scope.querySelectorAll('*')) { if (node.localName === 'select') nodes.push(node); if (node.shadowRoot) visit.tree(node.shadowRoot); } } };
    if (root.shadowRoot) visit.tree(root.shadowRoot);
    visit.tree(root); return nodes;
  },
  labelControl: (label: any) => label.isConnected ? label.control : null,
  // A visible semantic label can own an AX-excluded native select, but cannot
  // delegate an action into another record, region, form or document.
  labelSelect: (label: any) => {
    const control = label.control;
    if (label.localName !== 'label' || !label.isConnected || label.ownerDocument !== label.ownerDocument.defaultView?.document ||
        control?.localName !== 'select' || !control.isConnected || control.ownerDocument !== label.ownerDocument || !label.contains(control)) return null;
    for (let node = control; node !== label; node = node.parentElement) {
      if (!node || node.matches('article,tr,li,section,fieldset,form,dialog,[data-record-id],[data-row-id],[data-entity-id],[data-item-id]') ||
          node.hasAttribute('role') && !(node === control && node.getAttribute('role') === 'combobox') ||
          node !== control && (node.hasAttribute('aria-label') || node.hasAttribute('aria-labelledby'))) return null;
      if (node !== control) {
        // Only transparent wrappers transfer the label's proven ownership. A
        // nearer title, prose, control or region may describe another entity.
        const selects = node.querySelectorAll('select');
        if (selects.length !== 1 || selects[0] !== control) return null;
        const copy = node.cloneNode(true); copy.querySelector('select').remove();
        if (String(copy.textContent || '').trim() || copy.querySelector('article,tr,li,section,fieldset,form,dialog,h1,h2,h3,h4,h5,h6,legend,dt,th[scope],[role],[aria-label],[aria-labelledby],[data-record-id],[data-row-id],[data-entity-id],[data-item-id],input,select,textarea,button,a[href]')) return null;
      }
    }
    return control;
  },
  ancestors: (element: any) => { if (!element.isConnected) return []; const nodes = []; for (let node = element; node?.nodeType === 1; node = node.parentNode) nodes.push(node); return nodes; },

  visualTarget: (document: any, { x, y }: { x: number; y: number }) => {
    let element = document.elementFromPoint(x, y);
    while (element?.shadowRoot) {
      const inner = element.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === element) break;
      element = inner;
    }
    return element?.closest('button, a, input, textarea, select, [role], [contenteditable="true"]') ?? element;
  },
  clickLabel: (element: any) => {
    const el = element as any;
    const own = el.getBoundingClientRect();
    const selfHit = el.ownerDocument.elementFromPoint(own.left + own.width / 2, own.top + own.height / 2);
    if (own.width > 0 && own.height > 0 && (selfHit === el || el.contains(selfHit))) return null;
    const labels = Array.from(el.labels ?? []).filter((label: any) => {
      const rect = label.getBoundingClientRect(); const style = label.ownerDocument.defaultView.getComputedStyle(label);
      const hit = label.ownerDocument.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      return label.control === el && rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && (hit === label || label.contains(hit))
        && !Array.from(label.querySelectorAll('button,a,input,select,textarea,[role="button"]')).some(child => child !== el);
    });
    return labels.length === 1 ? labels[0] : null;
  },
  activationTarget: (element: any) => {
    const el = element as any;
    if (el.tagName !== 'INPUT' || ['checkbox','radio','button','submit','image','reset'].includes(el.type)) return null;
    const root = el.getRootNode();
    return el.form ? Array.from((root.documentElement ?? root).querySelectorAll('button,input')).find((control: any) => control.form === el.form && ['submit','image'].includes(control.type)) ?? null : null;
  },
  ownControl: (element: any) => (element as any).closest('button,a[href],input,select,textarea,summary,[role="button"],[role="link"],[role="checkbox"],[role="radio"],[role="switch"],[role="tab"],[role="menuitem"],[role="option"]'),
  submitter: (element: any) => {
        const el = element as any; const form = 'form' in el ? el.form : el.closest('form');
        const root = el.getRootNode();
        return form ? Array.from((root.documentElement ?? root).querySelectorAll('button,input')).find((control: any) => control.form === form && ['submit','image'].includes(control.type)) ?? null : null;
      },
  progressScope: (element: any, _input: undefined, nativeFacts: { progressBoundary(element: any): boolean }) => {
      if (element.form && !element.form.contains(element)) return element.form;
      let fieldScope = null;
      for (let node = (element as any).parentElement; node && !['BODY','HTML'].includes(node.tagName); node = node.parentElement) {
        if (node.matches('tr,li,article,section,[role="row"],[role="listitem"],[role="dialog"],[role="region"],[data-record-id],[data-row-id],[data-entity-id],[data-item-id],form,main')) return fieldScope ?? node;
        if (node.hasAttribute('aria-label') || node.hasAttribute('aria-labelledby')) return fieldScope ?? node;
        if (node.querySelector(':scope > h1,:scope > h2,:scope > h3,:scope > h4,:scope > [role="heading"],:scope > header > h1,:scope > header > h2,:scope > header > h3')) return fieldScope ?? node;
        if (!fieldScope && node.querySelector('input,select,textarea,[role="textbox"],[role="combobox"],[role="checkbox"],[role="radio"]')) fieldScope = node;
        // Fieldless component trees may keep the content and footer in sibling
        // wrappers. Use the closest owner of a heading, not a page-wide hash.
        if (Array.from(node.querySelectorAll('h1,h2,h3,h4,h5,h6,[role="heading"]')).some((heading: any) => {
          for (let parent = heading.parentElement; parent && parent !== node; parent = parent.parentElement) if (nativeFacts.progressBoundary(parent)) return false;
          return true;
        })) return fieldScope ?? node;
      }
      return fieldScope;
    },
  form: (el: any) => { const element = el as any; return 'form' in element ? element.form : element.closest('form'); },
};

export const snapshots = {
  selectOwnership: (anchor: any) => {
    const control = anchor.localName === 'label' ? anchor.control : anchor;
    const doc = anchor.ownerDocument;
    const scope = control?.form ?? anchor.parentElement ?? anchor.getRootNode()?.host;
    const connected = Boolean(anchor.isConnected && doc === doc.defaultView?.document && scope?.isConnected && control?.localName === 'select' && control.isConnected && control.ownerDocument === doc);
    return { facts: { connected, hasForm: Boolean(control?.form) }, nodes: connected ? [doc.documentElement, scope, ...(control.form ? [control.form] : [])] : [] };
  },
  credentialForm: (element: any) => {
    const form = 'form' in element ? element.form : element.closest('form');
    const controls = form ? Array.from(form.elements ?? []) as any[] : [element];
    const values = controls.map(control => String(control.value ?? (control.isContentEditable ? control.textContent : '') ?? ''));
    const destinations: string[] = [];
    if (element.href) destinations.push(String(element.href));
    if (form) {
      destinations.push(String(element.hasAttribute('formaction') ? element.formAction : form.action || element.ownerDocument.URL));
      for (const control of controls) if (control.hasAttribute?.('formaction')) destinations.push(String(control.formAction));
    }
    return { facts: { values, destinations, hasForm: Boolean(form) }, nodes: form ? [...controls, form] : controls };
  },
};
