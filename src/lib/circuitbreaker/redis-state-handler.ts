"use strict";

import {StateHandler, State} from "./express-circuit-breaker";
import {Gateway} from "../gateway";

class CircuitBreakerTopics {
    static BASE_TOPIC = '{circuitbreaker}:events'
    static CIRCUIT_CHANGED = `${CircuitBreakerTopics.BASE_TOPIC}:changed`;
}

class CircuitBreakerKeys {
    static CIRCUIT_BREAKER_FAILURES = '{circuitbreaker}:failures'
    static CIRCUIT_BREAKER_STATE = '{circuitbreaker}:state'
}

export class RedisStateHandler implements StateHandler {
    private id: string;
    private gateway: Gateway;
    private state: State;
    halfOpenCallPending: boolean;
    private resetTimeout: number;
    
    constructor(id: string, gateway: Gateway, resetTimeout: number) {
        this.id = id;
        this.gateway = gateway;
        this.resetTimeout = resetTimeout;
        this.subscribeEvents();
        // this.prefix = config.prefix;
        // this.duration = humanInterval(config.granularity.duration)/1000;
        // this.ttl = humanInterval(config.granularity.ttl)/1000;
    }

    initialState() {
        let self = this;
        this.gateway.redisClient.hget(CircuitBreakerKeys.CIRCUIT_BREAKER_STATE, this.id)
            .then(state => {
                if (state === 'open') {
                    self.openState();
                }
                else {
                    self.closeState();
                }
            }).catch(err => {
                self.forceClose();
            });    
    }


    isOpen(): boolean {
        return this.state === State.OPEN;
    }

    isHalfOpen(): boolean {
        return this.state === State.HALF_OPEN;
    }

    isClosed(): boolean {
        return this.state === State.CLOSED;
    }

    forceOpen(): boolean {
        if(!this.openState()) {
            return false;
        }
        this.notifyCircuitOpen();
        return true;
    }

    forceClose(): boolean {
        if(!this.closeState()) {
            return false;
        }
        this.notifyCircuitClose();
        return true;
    }

    forceHalfOpen(): boolean {
        if(this.state === State.HALF_OPEN) {
            return false;
        }

        this.state = State.HALF_OPEN;
        return true;
    }

    incrementFailures(): Promise<number> {
        return this.gateway.redisClient.hincrby(CircuitBreakerKeys.CIRCUIT_BREAKER_FAILURES, this.id, 1);
    }

    private openState(): boolean {
        if(this.state === State.OPEN) {
            return false;
        }

        this.state = State.OPEN;
        let self = this;
        // After reset timeout circuit should enter half open state
        setTimeout(function () {
            self.forceHalfOpen();
        }, self.resetTimeout);

        return true;        
    }

    private closeState() {
        if(this.state === State.CLOSED) {
            return false;
        }

        this.halfOpenCallPending = false;
        this.state = State.CLOSED;
        return true;        
    }

    private notifyCircuitOpen(): Promise<number> {
        if (this.gateway.logger.isDebugEnabled()) {
            this.gateway.logger.debug(`Notifying cluster that circuit for API ${this.id} is open`);
        }
        return this.gateway.redisClient.multi()
                .hset(CircuitBreakerKeys.CIRCUIT_BREAKER_STATE, this.id, 'open')
                .publish(`${CircuitBreakerTopics.CIRCUIT_CHANGED}:${this.id}`, JSON.stringify({state: 'open'}))
                .exec()
    }

    private notifyCircuitClose(): Promise<number> {
        if (this.gateway.logger.isDebugEnabled()) {
            this.gateway.logger.debug(`Notifying cluster that circuit for API ${this.id} is closed`);
        }

        return this.gateway.redisClient.multi()
                .hset(CircuitBreakerKeys.CIRCUIT_BREAKER_STATE, this.id, 'close')
                .hdel(CircuitBreakerKeys.CIRCUIT_BREAKER_FAILURES, this.id)
                .publish(`${CircuitBreakerTopics.CIRCUIT_CHANGED}:${this.id}`, JSON.stringify({state: 'close'}))
                .exec();
    }

    private subscribeEvents(): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            const topicPattern = `${CircuitBreakerTopics.BASE_TOPIC}:${this.id}`;

            this.gateway.redisEvents.subscribe(topicPattern)
                .then(() => {
                    return this.gateway.redisEvents.on('message', (pattern, channel, message) => {
                        try {
                            this.onStateChanged(channel, JSON.parse(message));
                        } catch (err) {
                            this.gateway.logger.error(`Error processing config event: ${err.message}`);
                        }
                    });
                })
                .then(() => {
                    if (this.gateway.logger.isDebugEnabled()) {
                        this.gateway.logger.debug(`Listening to events on topic ${topicPattern}`);
                    }

                    resolve();
                })
                .catch(reject);
        });
    }    

    private onStateChanged(channel: string, message) {
        switch (message.state) {
            case 'open':
                if (this.gateway.logger.isDebugEnabled()) {
                    this.gateway.logger.debug(`Notification received: Circuit for API ${this.id} is open`);
                }
                this.openState();
            break;
            case 'close':
                if (this.gateway.logger.isDebugEnabled()) {
                    this.gateway.logger.debug(`Notification received: Circuit for API ${this.id} is closed`);
                }
                this.closeState();
            break;
        }
    } 
}