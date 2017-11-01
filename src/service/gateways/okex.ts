/// <reference path="../utils.ts" />
/// <reference path="../../common/models.ts" />
/// <reference path="nullgw.ts" />
///<reference path="../interfaces.ts"/>

import ws = require('ws');
import Q = require("q");
import crypto = require("crypto");
import request = require("request");
import url = require("url");
import querystring = require("querystring");
import Config = require("../config");
import NullGateway = require("./nullgw");
import Models = require("../../common/models");
import Utils = require("../utils");
import util = require("util");
import Interfaces = require("../interfaces");
import moment = require("moment");
import _ = require("lodash");
import log from "../logging";
var shortId = require("shortid");

interface OkexMessageIncomingMessage {
    channel : string;
    success : string;
    data : any;
    event? : string;
}

interface OkexDepthMessage {
    asks : [number, number][];
    bids : [number, number][];
    timestamp : string;
}

interface OrderAck {
    result: string; // "true" or "false"
    order_id: number;
}

interface SignedMessage {
    api_key?: string;
    sign?: string;
}

interface Order extends SignedMessage {
    symbol: string;
    type: string;
    price: string;
    amount: string;
}

interface Cancel extends SignedMessage {
    order_id: string;
    symbol: string;
}

interface OkexTradeRecord {
    averagePrice: string;
    completedTradeAmount: string;
    createdDate: string;
    id: string;
    orderId: string;
    sigTradeAmount: string;
    sigTradePrice: string;
    status: number;
    symbol: string;
    tradeAmount: string;
    tradePrice: string;
    tradeType: string;
    tradeUnitPrice: string;
    unTrade: string;
}

interface SubscriptionRequest extends SignedMessage { }

class OkexWebsocket {
	send = <T>(channel : string, parameters: any, cb?: () => void) => {
        var subsReq : any = {event: 'addChannel', channel: channel};
        
        if (parameters !== null) 
            subsReq.parameters = parameters;
        
        this._ws.send(JSON.stringify(subsReq), (e: Error) => {
            if (!e && cb) cb();
        });
    }
    
    setHandler = <T>(channel : string, handler: (newMsg : Models.Timestamped<T>) => void) => {
        this._handlers[channel] = handler;
    }

    private onMessage = (raw : string) => {
        console.log('...onMessage', raw);
        var t = Utils.date();
        try {
            var msg : OkexMessageIncomingMessage = JSON.parse(raw)[0];

            if (typeof msg.event !== "undefined" && msg.event == "ping") {
                this._ws.send(this._serializedHeartbeat);
                return;
            }

            if (typeof msg.success !== "undefined") {
                if (msg.success !== "true")
                    this._log.warn("Unsuccessful message", msg);
                else
                    this._log.info("Successfully connected to %s", msg.channel);
                return;
            }

            var handler = this._handlers[msg.channel];

            if (typeof handler === "undefined") {
                this._log.warn("Got message on unknown topic", msg);
                return;
            }

            handler(new Models.Timestamped(msg.data, t));
        }
        catch (e) {
            this._log.error(e, "Error parsing msg %o", raw);
            throw e;
        }
    };

    ConnectChanged = new Utils.Evt<Models.ConnectivityStatus>();
    private _serializedHeartbeat = JSON.stringify({event: "pong"});
    private _log = log("tribeca:gateway:OkexWebsocket");
    private _handlers : { [channel : string] : (newMsg : Models.Timestamped<any>) => void} = {};
    private _ws : ws;
    constructor(config : Config.IConfigProvider) {
        this._ws = new ws(config.GetString("OkexWsUrl"));

        this._ws.on("open", () => {
            this.ConnectChanged.trigger(Models.ConnectivityStatus.Connected); 
        });
        this._ws.on("message", this.onMessage);
        this._ws.on("close", () => {
            this.ConnectChanged.trigger(Models.ConnectivityStatus.Disconnected)
        });
    }
}

class OkexMarketDataGateway implements Interfaces.IMarketDataGateway {
    ConnectChanged = new Utils.Evt<Models.ConnectivityStatus>();

    MarketTrade = new Utils.Evt<Models.GatewayMarketTrade>();
    private onTrade = (trades : Models.Timestamped<[string,string,string,string,string][]>) => {
        // [tid, price, amount, time, type]
        _.forEach(trades.data, trade => {
            var px = parseFloat(trade[1]);
            var amt = parseFloat(trade[2]);
            var side = trade[4] === "ask" ? Models.Side.Ask : Models.Side.Bid; // is this the make side?
            var mt = new Models.GatewayMarketTrade(px, amt, trades.time, trades.data.length > 0, side);
            this.MarketTrade.trigger(mt);
        });
    };

    MarketData = new Utils.Evt<Models.Market>();
    
    private static GetLevel = (n: [number, number]) : Models.MarketSide => 
        new Models.MarketSide(n[0], n[1]);
        
    private readonly Depth: number = 25;
    private onDepth = (depth : Models.Timestamped<OkexDepthMessage>) => {
        var msg = depth.data;

        var bids = _(msg.bids).take(this.Depth).map(OkexMarketDataGateway.GetLevel).value();
        var asks = _(msg.asks).reverse().take(this.Depth).map(OkexMarketDataGateway.GetLevel).value()
        var mkt = new Models.Market(bids, asks, depth.time);

        this.MarketData.trigger(mkt);
    };

    private _log = log("tribeca:gateway:OkexMD");
    constructor(socket : OkexWebsocket, symbolProvider: OkexSymbolProvider) {
        var depthChannel = "ok_sub_spot_" + symbolProvider.symbol.toLowerCase() + "_depth_20";
        var tradesChannel = "ok_sub_spot_" + symbolProvider.symbol.toLowerCase() + "_deals";
        socket.setHandler(depthChannel, this.onDepth);
        socket.setHandler(tradesChannel, this.onTrade);
        
        socket.ConnectChanged.on(cs => {
            this.ConnectChanged.trigger(cs);
            
            if (cs == Models.ConnectivityStatus.Connected) {
                socket.send(depthChannel, {});
                socket.send(tradesChannel, {});
            }
        });
    }
}

class OkexOrderEntryGateway implements Interfaces.IOrderEntryGateway {
    OrderUpdate = new Utils.Evt<Models.OrderStatusUpdate>();
    ConnectChanged = new Utils.Evt<Models.ConnectivityStatus>();

    generateClientOrderId = () => shortId.generate();
    
    supportsCancelAllOpenOrders = () : boolean => { return false; };
    cancelAllOpenOrders = () : Q.Promise<number> => { return Q(0); };

    public cancelsByClientOrderId = false;
    
    private static GetOrderType(side: Models.Side, type: Models.OrderType) : string {
        if (side === Models.Side.Bid) {
            if (type === Models.OrderType.Limit) return "buy";
            if (type === Models.OrderType.Market) return "buy_market";
        }
        if (side === Models.Side.Ask) {
            if (type === Models.OrderType.Limit) return "sell";
            if (type === Models.OrderType.Market) return "sell_market";
        }
        throw new Error("unable to convert " + Models.Side[side] + " and " + Models.OrderType[type]);
    }
    
    // let's really hope there's no race conditions on their end -- we're assuming here that orders sent first
    // will be acked first, so we can match up orders and their acks
    private _ordersWaitingForAckQueue = [];

    sendOrder = (order : Models.OrderStatusReport) => {
        var o : Order = {
            symbol: this._symbolProvider.symbol,
            type: OkexOrderEntryGateway.GetOrderType(order.side, order.type),
            price: order.price.toString(),
            amount: order.quantity.toString()};
            
        this._ordersWaitingForAckQueue.push(order.orderId);
            
        this._socket.send<OrderAck>("ok_spot_order", this._signer.signMessage(o), () => {
            this.OrderUpdate.trigger({
                orderId: order.orderId,
                computationalLatency: Utils.fastDiff(Utils.date(), order.time)
            });
        });
    };
    
    private onOrderAck = (ts: Models.Timestamped<OrderAck>) => {
        var orderId = this._ordersWaitingForAckQueue.shift();
        if (typeof orderId === "undefined") {
            this._log.error("got an order ack when there was no order queued!", util.format(ts.data));
            return;
        }
        
        var osr : Models.OrderStatusUpdate = { orderId: orderId, time: ts.time };
            
        if (ts.data.result === "true") {
            osr.exchangeId = ts.data.order_id.toString();
            osr.orderStatus = Models.OrderStatus.Working;
        } 
        else {
            osr.orderStatus = Models.OrderStatus.Rejected;
        }
        
        this.OrderUpdate.trigger(osr);
    };

    cancelOrder = (cancel : Models.OrderStatusReport) => {
        var c : Cancel = {order_id: cancel.exchangeId, symbol: this._symbolProvider.symbol };
        this._socket.send<OrderAck>("ok_spot_cancel_order", this._signer.signMessage(c), () => {
            this.OrderUpdate.trigger({
                orderId: cancel.orderId,
                computationalLatency: Utils.fastDiff(Utils.date(), cancel.time)
            });
        });
    };
    
    private onCancel = (ts: Models.Timestamped<OrderAck>) => {
        var osr : Models.OrderStatusUpdate = { exchangeId: ts.data.order_id.toString(), time: ts.time };
            
        if (ts.data.result === "true") {
            osr.orderStatus = Models.OrderStatus.Cancelled;
        }
        else {
            osr.orderStatus = Models.OrderStatus.Rejected;
            osr.cancelRejected = true;
        }
        
        this.OrderUpdate.trigger(osr);
    };

    replaceOrder = (replace : Models.OrderStatusReport) => {
        this.cancelOrder(replace);
        this.sendOrder(replace);
    };
    
    private static getStatus(status: number) : Models.OrderStatus {
        // status: -1: cancelled, 0: pending, 1: partially filled, 2: fully filled, 4: cancel request in process
        switch (status) {
            case -1: return Models.OrderStatus.Cancelled;
            case 0: return Models.OrderStatus.Working;
            case 1: return Models.OrderStatus.Working;
            case 2: return Models.OrderStatus.Complete;
            case 4: return Models.OrderStatus.Working;
            default: return Models.OrderStatus.Other;
        }
    }

    private onTrade = (tsMsg : Models.Timestamped<OkexTradeRecord>) => {
        var t = tsMsg.time;
        var msg : OkexTradeRecord = tsMsg.data;
        
        var avgPx = parseFloat(msg.averagePrice);
        var lastQty = parseFloat(msg.sigTradeAmount);
        var lastPx = parseFloat(msg.sigTradePrice);

        var status : Models.OrderStatusUpdate = {
            exchangeId: msg.orderId.toString(),
            orderStatus: OkexOrderEntryGateway.getStatus(msg.status),
            time: t,
            lastQuantity: lastQty > 0 ? lastQty : undefined,
            lastPrice: lastPx > 0 ? lastPx : undefined,
            averagePrice: avgPx > 0 ? avgPx : undefined,
            pendingCancel: msg.status === 4,
            partiallyFilled: msg.status === 1
        };

        this.OrderUpdate.trigger(status);
    };

    private _log = log("tribeca:gateway:OkexOE");
    constructor(
            private _socket : OkexWebsocket, 
            private _signer: OkexMessageSigner,
            private _symbolProvider: OkexSymbolProvider) {
        var orderChannel = "ok_sub_spot_" + _symbolProvider.symbol.toLowerCase() + "_order";
        _socket.setHandler(orderChannel, this.onTrade); // 订单状态通知
        _socket.setHandler("ok_spot_order", this.onOrderAck); // 下单是否成功
        _socket.setHandler("ok_spot_cancel_order", this.onCancel); // 撤单是否成功
        
        _socket.ConnectChanged.on(cs => {
            this.ConnectChanged.trigger(cs);
            
            if (cs === Models.ConnectivityStatus.Connected) {
                // 需要订单状态通知
                _socket.send(orderChannel, _signer.signMessage({}));
            }
        });
    }
}

class OkexMessageSigner {
    private _secretKey : string;
    private _api_key : string;
    
    public signMessage = (m : SignedMessage) : SignedMessage => {
        var els : string[] = [];
        
        if (!m.hasOwnProperty("api_key"))
            m.api_key = this._api_key;

        var keys = [];
        for (var key in m) {
            if (m.hasOwnProperty(key))
                keys.push(key);
        }
        keys.sort();

        for (var i = 0; i < keys.length; i++) {
            const k = keys[i];
            if (m.hasOwnProperty(k))
                els.push(k + "=" + m[k]);
        }

        var sig = els.join("&") + "&secret_key=" + this._secretKey;
        m.sign = crypto.createHash('md5').update(sig).digest("hex").toString().toUpperCase();
        return m;
    };
    
    constructor(config : Config.IConfigProvider) {
        this._api_key = config.GetString("OkexApiKey");
        this._secretKey = config.GetString("OkexSecretKey");
    }
}

class OkexHttp {
    post = <T>(actionUrl: string, msg : SignedMessage) : Q.Promise<Models.Timestamped<T>> => {
        var d = Q.defer<Models.Timestamped<T>>();

        request({
            url: url.resolve(this._baseUrl, actionUrl),
            body: querystring.stringify(this._signer.signMessage(msg)),
            headers: {"Content-Type": "application/x-www-form-urlencoded"},
            method: "POST"
        }, (err, resp, body) => {
            if (err) d.reject(err);
            else {
                try {
                    var t = Utils.date();
                    var data = JSON.parse(body);
                    d.resolve(new Models.Timestamped(data, t));
                }
                catch (e) {
                    this._log.error(err, "url: %s, err: %o, body: %o", actionUrl, err, body);
                    d.reject(e);
                }
            }
        });
        
        return d.promise;
    };

    private _log = log("tribeca:gateway:OkexHTTP");
    private _baseUrl : string;
    constructor(config : Config.IConfigProvider, private _signer: OkexMessageSigner) {
        this._baseUrl = config.GetString("OkexHttpUrl")
    }
}

class OkexPositionGateway implements Interfaces.IPositionGateway {
    PositionUpdate = new Utils.Evt<Models.CurrencyPosition>();

    private static convertCurrency(name : string) : Models.Currency {
        switch (name.toLowerCase()) {
            case "usd": return Models.Currency.USD;
            case "ltc": return Models.Currency.LTC;
            case "btc": return Models.Currency.BTC;
			case "bt1": return Models.Currency.BT1;
			case "bt2": return Models.Currency.BT2;
			case "bcc": return Models.Currency.BCC;
			case "bcs": return Models.Currency.BCS;
			case "btg": return Models.Currency.BTG;
			case "etc": return Models.Currency.ETC;
			case "eth": return Models.Currency.ETH;
			case "usdt": return Models.Currency.USDT;
            default: throw new Error("Unsupported currency " + name);
        }
    }

    private trigger = () => {
        this._http.post("userinfo.do", {}).then(msg => {
            var free = (<any>msg.data).info.funds.free;
            var freezed = (<any>msg.data).info.funds.freezed;

            for (var currencyName in free) {
                if (!free.hasOwnProperty(currencyName)) continue;
                var amount = parseFloat(free[currencyName]);
                var held = parseFloat(freezed[currencyName]);

                var pos = new Models.CurrencyPosition(amount, held, OkexPositionGateway.convertCurrency(currencyName));
                this.PositionUpdate.trigger(pos);
            }
        }).done();
    };

    private _log = log("tribeca:gateway:OkexPG");
    constructor(private _http : OkexHttp) {
        setInterval(this.trigger, 15000);
        setTimeout(this.trigger, 10);
    }
}

class OkexBaseGateway implements Interfaces.IExchangeDetailsGateway {
    public get hasSelfTradePrevention() {
        return false;
    }

    name() : string {
        return "Okex";
    }

    makeFee() : number {
        return -0.001;
    }

    takeFee() : number {
        return 0.001;
    }

    exchange() : Models.Exchange {
        return Models.Exchange.Okex;
    }
    
    constructor(public minTickIncrement: number) {}
}

class OkexSymbolProvider {
    public symbol : string;
    public symbolWithoutUnderscore: string;
    
    constructor(pair: Models.CurrencyPair) {
        const GetCurrencySymbol = (s: Models.Currency) : string => Models.fromCurrency(s);
        this.symbol = GetCurrencySymbol(pair.base) + "_" + GetCurrencySymbol(pair.quote);
        this.symbolWithoutUnderscore = GetCurrencySymbol(pair.base) + GetCurrencySymbol(pair.quote);
    }
}

class Okex extends Interfaces.CombinedGateway {
    constructor(config : Config.IConfigProvider, pair: Models.CurrencyPair) {
        var symbol = new OkexSymbolProvider(pair);
        var signer = new OkexMessageSigner(config);
        var http = new OkexHttp(config, signer);
        var socket = new OkexWebsocket(config);

        var orderGateway = config.GetString("OkexOrderDestination") == "Okex"
            ? <Interfaces.IOrderEntryGateway>new OkexOrderEntryGateway(socket, signer, symbol)
            : new NullGateway.NullOrderGateway();

        super(
            new OkexMarketDataGateway(socket, symbol),
            orderGateway,
            new OkexPositionGateway(http),
            new OkexBaseGateway(.01)); // uh... todo
        }
}

export async function createOkex(config : Config.IConfigProvider, pair: Models.CurrencyPair) : Promise<Interfaces.CombinedGateway> {
    return new Okex(config, pair);
}