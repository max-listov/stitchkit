import type { Session } from './contract';

export { SessionError, SessionSchema, sessions } from './contract';

export const isBusy = (session: Session): boolean => session.state === 'busy';
