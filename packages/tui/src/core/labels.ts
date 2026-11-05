import { type TerminalFormMessages, terminalFormMessages } from './form';

/**
 * Every word the kit's widgets draw. A product passes its own language once,
 * through `TerminalLabelsProvider`, and no widget carries a hard-coded string.
 */
export interface TerminalLabels {
  form: TerminalFormMessages;
  rows: (shown: number, total: number) => string;
  filter: string;
  nothingFound: string;
  moreAbove: (count: number) => string;
  moreBelow: (count: number) => string;
  loading: string;
  empty: string;
  error: string;
  retry: string;
  yes: string;
  no: string;
  back: string;
  open: string;
  move: string;
  page: string;
  search: string;
  /** The key hint for type-to-search lists. */
  typing: string;
  submit: string;
  next: string;
  change: string;
  sort: string;
  invert: string;
  expand: string;
  collapse: string;
  tabs: string;
  pick: string;
  help: string;
  quit: string;
  top: string;
  bottom: string;
  required: string;
  /** What a form with no fields shows: Enter still submits it. */
  noFields: string;
  /** The heading `runTerminalApp` draws above an error that escaped the screens. */
  crashed: string;
  scroll: (percent: number) => string;
}

export const terminalLabelsEn: TerminalLabels = Object.freeze<TerminalLabels>({
  form: terminalFormMessages,
  rows: (shown, total) =>
    shown === total ? `${total} ${total === 1 ? 'row' : 'rows'}` : `${shown} of ${total} rows`,
  filter: 'filter',
  nothingFound: 'Nothing found',
  moreAbove: (count) => `↑ ${count} more`,
  moreBelow: (count) => `↓ ${count} more`,
  loading: 'Loading',
  empty: 'Nothing here yet',
  error: 'Failed',
  retry: 'retry',
  yes: 'Yes',
  no: 'No',
  back: 'back',
  open: 'open',
  move: 'move',
  page: 'page',
  search: 'search',
  typing: 'type',
  submit: 'submit',
  next: 'next field',
  change: 'change',
  sort: 'sort',
  invert: 'invert',
  expand: 'expand',
  collapse: 'collapse',
  tabs: 'views',
  pick: 'pick',
  help: 'help',
  quit: 'quit',
  top: 'top',
  bottom: 'bottom',
  required: 'required',
  noFields: 'No parameters · Enter to run',
  crashed: 'The application stopped on an error',
  scroll: (percent) => `${percent}%`,
});

export const terminalLabelsRu: TerminalLabels = Object.freeze<TerminalLabels>({
  form: {
    required: 'Обязательное поле',
    number: 'Нужно число',
    integer: 'Нужно целое число',
    choice: (choices: readonly string[]) => `Выберите одно из: ${choices.join(', ')}`,
    json: (reason: string) => `Неверный JSON: ${reason}`,
  },
  rows: (shown, total) => (shown === total ? `строк: ${total}` : `${shown} из ${total}`),
  filter: 'фильтр',
  nothingFound: 'Ничего не найдено',
  moreAbove: (count) => `↑ ещё ${count}`,
  moreBelow: (count) => `↓ ещё ${count}`,
  loading: 'Загрузка',
  empty: 'Пока пусто',
  error: 'Ошибка',
  retry: 'повторить',
  yes: 'Да',
  no: 'Нет',
  back: 'назад',
  open: 'открыть',
  move: 'выбор',
  page: 'страница',
  search: 'поиск',
  typing: 'печатайте',
  submit: 'выполнить',
  next: 'следующее поле',
  change: 'изменить',
  sort: 'сортировка',
  invert: 'обратный порядок',
  expand: 'раскрыть',
  collapse: 'свернуть',
  tabs: 'вкладки',
  pick: 'отметить',
  help: 'справка',
  quit: 'выход',
  top: 'в начало',
  bottom: 'в конец',
  required: 'обязательно',
  noFields: 'Параметров нет · Enter — выполнить',
  crashed: 'Приложение остановилось из-за ошибки',
  scroll: (percent) => `${percent}%`,
});
