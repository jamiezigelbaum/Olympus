import { Window } from 'happy-dom';

/** Query inert rendered markup; selector literals inside scripts are not controls. */
export function htmlHasSelector(html: string, selector: string): boolean {
  const template = new Window().document.createElement('template');
  template.innerHTML = html;
  return template.content.querySelector(selector) !== null;
}
