(() => {
  'use strict';

  const PORT = {
    REQUEST_STATE: 'REQUEST_STATE',
    STATE: 'STATE',
    REQUEST_EVENTS: 'REQUEST_EVENTS',
    EVENTS: 'EVENTS',
    EVENTS_APPEND: 'EVENTS_APPEND',
    CLEAR_EVENTS: 'CLEAR_EVENTS',
    EVENTS_CLEARED: 'EVENTS_CLEARED',
    CLEAR_LISTENERS: 'CLEAR_LISTENERS',
    LISTENERS_CLEARED: 'LISTENERS_CLEARED',
    REQUEST_FRAME_TREE: 'REQUEST_FRAME_TREE',
    FRAME_TREE: 'FRAME_TREE'
  } as const;

  type FransceiverMessagesType = {
    PORT: typeof PORT;
  };

  const globalObj = globalThis as typeof globalThis & {
    FransceiverMessages?: Partial<FransceiverMessagesType>;
  };

  globalObj.FransceiverMessages = Object.assign(globalObj.FransceiverMessages || {}, {
    PORT
  });
})();
