import health from './health/index';
import link from './link/index';
import profiles from './profiles/index';
import proxy from './proxy/index';
import type {BotModule} from './types';

/** Every module, in dispatch order. */
export const modules: BotModule[] = [link, health, proxy, profiles];
