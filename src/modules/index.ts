import health from './health/index';
import help from './help/index';
import link from './link/index';
import profiles from './profiles/index';
import proxy from './proxy/index';
import type {BotModule} from './types';

export const modules: BotModule[] = [help, link, health, proxy, profiles];
