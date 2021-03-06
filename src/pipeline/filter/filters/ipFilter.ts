'use strict';

import * as Joi from 'joi';
import * as _ from 'lodash';
import * as express from 'express';
import { ValidationError } from '../../../config/errors';
import { Container } from 'typescript-ioc';
import { Gateway } from '../../../gateway';
import { Logger } from '../../../logger';
import { getMilisecondsInterval } from '../../../utils/time-intervals';
import { PluginsDataService } from '../../../service/plugin-data';
import * as mm from 'micromatch';

const IPV6_PREFIX = '::ffff:';

interface IpFilterConfig {
    blacklist?: Array<string>;
    database?: IpFilterDatabaseConfig;
    message?: string;
    statusCode?: number;
    whitelist?: Array<string>;
}

interface IpFilterDatabaseConfig {
    key?: string;
    checkInterval?: string | number;
}

const ipFilterConfigSchema = Joi.object().keys({
    blacklist: Joi.alternatives([Joi.array().items(Joi.string()), Joi.string()]),
    database: Joi.object().keys({
        checkInterval: Joi.alternatives([Joi.string(), Joi.number().positive()]),
        key: Joi.string()
    }),
    message: Joi.string(),
    statusCode: Joi.number(),
    whitelist: Joi.alternatives([Joi.array().items(Joi.string()), Joi.string()]),
}).xor('blacklist', 'whitelist');

function validateIpFilterConfig(config: IpFilterConfig) {
    const result = Joi.validate(config, ipFilterConfigSchema);
    if (result.error) {
        throw new ValidationError(result.error);
    } else {
        return result.value;
    }
}

function getBlacklistFilter(config: IpFilterConfig) {
    const gateway: Gateway = Container.get(Gateway);
    const logger: Logger = Container.get(Logger);

    config.blacklist = _.castArray(config.blacklist || []);
    let blocked: Array<string> = config.blacklist;
    if (config.database) {
        const pluginsDataService: PluginsDataService = Container.get(PluginsDataService);
        pluginsDataService.on('changed', (configKey: string, data: Array<string>) => {
            blocked = _.union(config.blacklist, data || []);
        });
        const watcher = pluginsDataService.watchConfigurationItems(config.database.key || 'ipFilter:blacklist',
            getMilisecondsInterval(config.database.checkInterval, 30000));
        const stop = () => {
            if (logger.isDebugEnabled()) {
                logger.debug('Gateway stopped. Removing database monitors for ipFilter.');
            }
            pluginsDataService.stopWatchingConfigurationItems(watcher);
            pluginsDataService.removeAllListeners('changed');
            gateway.removeListener('stop', stop);
            gateway.removeListener('api-reload', stop);
        };
        gateway.on('stop', stop);
        gateway.on('api-reload', stop);
    }
    return (req: express.Request, res: express.Response) => {
        if (!blocked || !blocked.length) {
            return true;
        }
        let ip: string = req.ip || req.connection.remoteAddress;
        let allowed = !mm.any(ip, blocked);
        if (allowed && ip.startsWith(IPV6_PREFIX)) {
            ip = ip.substring(IPV6_PREFIX.length);
            allowed = !mm.any(ip, blocked);
        }
        if (!allowed) {
            res.status(config.statusCode || 403).send(config.message || 'Not allowed.');
        }
        return allowed;
    };
}

function getWhitelistFilter(config: IpFilterConfig) {
    const gateway: Gateway = Container.get(Gateway);
    const logger: Logger = Container.get(Logger);

    config.whitelist = _.castArray(config.whitelist || []);
    let unblocked: Array<string> = config.whitelist;
    if (config.database) {
        const pluginsDataService: PluginsDataService = Container.get(PluginsDataService);
        pluginsDataService.on('changed', (configKey: string, data: Array<string>) => {
            unblocked = _.union(config.whitelist, data || []);
        });
        const watcher = pluginsDataService.watchConfigurationItems(config.database.key || '{ipFilter}:whitelist',
            getMilisecondsInterval(config.database.checkInterval, 30000));
        const stop = () => {
            if (logger.isDebugEnabled()) {
                logger.debug('Gateway stopped. Removing database monitors for ipFilter.');
            }
            pluginsDataService.stopWatchingConfigurationItems(watcher);
            pluginsDataService.removeAllListeners('changed');
            gateway.removeListener('stop', stop);
            gateway.removeListener('api-reload', stop);
        };
        gateway.on('stop', stop);
        gateway.on('api-reload', stop);
    }
    return (req: express.Request, res: express.Response) => {
        if (!unblocked) {
            return true;
        }
        let ip: string = req.ip || req.connection.remoteAddress;
        let allowed = mm.any(ip, unblocked);
        if (!allowed && ip.startsWith(IPV6_PREFIX)) {
            ip = ip.substring(IPV6_PREFIX.length);
            allowed = mm.any(ip, unblocked);
        }
        if (!allowed) {
            res.status(config.statusCode || 403).send(config.message || 'IP not allowed.');
        }
        return allowed;
    };
}

module.exports = function(config: IpFilterConfig) {
    validateIpFilterConfig(config);
    if (config.whitelist) {
        return getWhitelistFilter(config);
    }
    return getBlacklistFilter(config);
};
module.exports.factory = true;
