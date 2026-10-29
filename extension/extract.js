/* Content extraction is independent of the speech provider. */
(() => {
  const BLOCKS = 'p,li,blockquote,h1,h2,h3,h4,h5,h6,pre,figcaption,td,th,div';
  const SKIP = 'script,style,noscript,button,svg,math,iframe,[hidden],[aria-hidden="true"],.zv-controls';
  const BODY = '.RichText.ztext, .RichText, .RichContent-inner';
  const ITEM = `.AnswerItem, .ArticleItem, [data-zop*='"type":"answer"'], [data-zop*='"type":"article"']`;
  const EXPAND = /^(展开阅读全文|展开全部|阅读全文|显示全部|展开)(?:\s|\u200b|[»›→])*$/;

  function visible(element) {
    for (let node = element; node && node.nodeType === 1; node = node.parentElement) {
      if (node.matches('[hidden],[aria-hidden="true"]')) return false;
      const style = getComputedStyle(node);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
    }
    return true;
  }
  function expandButton(answer) {
    return [...answer.querySelectorAll('button, [role="button"]')].find(button =>
      button.closest(ITEM) === answer && !button.closest('.zv-controls') && visible(button) && EXPAND.test((button.textContent || '').trim()));
  }
  function extract(answer) {
    const body = [...answer.querySelectorAll(BODY)].find(element => element.closest(ITEM) === answer);
    if (!body || !visible(body)) return { paragraphs: [], incomplete: true };
    const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
    const paragraphs = [];
    let lastElement = null;
    let node;
    while ((node = walker.nextNode())) {
      const parent = node.parentElement;
      if (!parent || parent.closest(ITEM) !== answer || parent.closest(SKIP) || !visible(parent)) continue;
      const text = node.nodeValue.replace(/\u200b/g, '');
      const closest = parent.closest(BLOCKS);
      const element = closest && body.contains(closest) ? closest : body;
      if (!text.trim() && element !== lastElement) continue;
      if (element === lastElement) paragraphs[paragraphs.length - 1].text += text;
      else {
        paragraphs.push({ element, text });
        lastElement = element;
      }
    }
    for (const paragraph of paragraphs) paragraph.text = paragraph.text.replace(/\s+/g, ' ').trim();
    return { paragraphs: paragraphs.filter(p => p.text), incomplete: Boolean(expandButton(answer) || [...answer.querySelectorAll('.RichContent.is-collapsed, .RichContent--collapsed, .RichContent-inner--collapsed')].some(element => element.closest(ITEM) === answer && visible(element))) };
  }
  globalThis.ZhihuVoiceExtract = { extract, expandButton };
})();
