import { toRealtimeContract, watchContract } from 'stitchkit/live';
import { boardEvents } from './board';

/**
 * Everything this application says over its one socket.
 *
 * Its own announcements, projected from the same declaration both ends read,
 * plus the protocol a watched read travels on. Declared in `shared` because the
 * server binds it and the browser binds it, and a contract described twice is a
 * contract that will be published in one shape and parsed in another — which is
 * the failure `defineContract` exists to make impossible for requests and this
 * makes impossible for announcements.
 */
export const liveContract = {
  serverToClient: {
    ...toRealtimeContract(boardEvents).serverToClient,
    ...watchContract.serverToClient,
  },
  clientToServer: watchContract.clientToServer,
};
