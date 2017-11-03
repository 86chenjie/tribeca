/// <reference path="../common/models.ts" />
/// <reference path="config.ts" />
/// <reference path="utils.ts" />
///<reference path="interfaces.ts"/>

import * as moment from "moment";
import Config = require("./config");
import Models = require("../common/models");
import Utils = require("./utils");
import Interfaces = require("./interfaces");

class QuoteOrder { // 订单号 + 价量
    constructor(public quote: Models.Quote, public orderId: string) { }
}

// aggregator for quoting
export class Quoter {
    private _bidQuoter: ExchangeQuoter; // 买方向的quote订单管理
    private _askQuoter: ExchangeQuoter; // 卖方向的quote订单管理

    constructor(broker: Interfaces.IOrderBroker,
        exchBroker: Interfaces.IBroker) {
        this._bidQuoter = new ExchangeQuoter(broker, exchBroker, Models.Side.Bid);
        this._askQuoter = new ExchangeQuoter(broker, exchBroker, Models.Side.Ask);
    }

	// 更新quote，传入 价量/买卖方向
    public updateQuote = (q: Models.Timestamped<Models.Quote>, side: Models.Side): Models.QuoteSent => {
        switch (side) {
            case Models.Side.Ask:
                return this._askQuoter.updateQuote(q);
            case Models.Side.Bid:
                return this._bidQuoter.updateQuote(q);
        }
    };

	// 取消quote，传入 方向
    public cancelQuote = (s: Models.Timestamped<Models.Side>): Models.QuoteSent => {
        switch (s.data) {
            case Models.Side.Ask:
                return this._askQuoter.cancelQuote(s.time);
            case Models.Side.Bid:
                return this._bidQuoter.cancelQuote(s.time);
        }
    };

	// 获取所有的quote订单列表
    public quotesSent = (s: Models.Side) => {
        switch (s) {
            case Models.Side.Ask:
                return this._askQuoter.quotesSent;
            case Models.Side.Bid:
                return this._bidQuoter.quotesSent;
        }
    };
}

// wraps a single broker to make orders behave like quotes
// 保存所有的quote订单 / 当前quote订单
export class ExchangeQuoter {
    private _activeQuote: QuoteOrder = null;
    private _exchange: Models.Exchange;

    public quotesSent: QuoteOrder[] = []; // 所有发出的quote订单

    constructor(private _broker: Interfaces.IOrderBroker,
        private _exchBroker: Interfaces.IBroker,
        private _side: Models.Side) {
        this._exchange = _exchBroker.exchange();
        this._broker.OrderUpdate.on(this.handleOrderUpdate);
    }

	// 订单状态变化通知
    private handleOrderUpdate = (o: Models.OrderStatusReport) => {
        switch (o.orderStatus) {
            case Models.OrderStatus.Cancelled:
            case Models.OrderStatus.Complete:
            case Models.OrderStatus.Rejected: // 订单被拒绝
                const bySide = this._activeQuote;
                if (bySide !== null && bySide.orderId === o.orderId) { // 取消quote订单
                    this._activeQuote = null;
                }

                this.quotesSent = this.quotesSent.filter(q => q.orderId !== o.orderId); // 过滤被拒绝的订单
        }
    };

	// 返回quote的发送状态
    public updateQuote = (q: Models.Timestamped<Models.Quote>): Models.QuoteSent => {
        if (this._exchBroker.connectStatus !== Models.ConnectivityStatus.Connected) // 没有连接
            return Models.QuoteSent.UnableToSend; // quote无法发送

        if (this._activeQuote !== null) {
            return this.modify(q);
        }
        return this.start(q);
    };

	// 取消订单
    public cancelQuote = (t: Date): Models.QuoteSent => {
        if (this._exchBroker.connectStatus !== Models.ConnectivityStatus.Connected)
            return Models.QuoteSent.UnableToSend;

        return this.stop(t);
    };

	// 先取消，再发送quote订单
    private modify = (q: Models.Timestamped<Models.Quote>): Models.QuoteSent => {
        this.stop(q.time);
        this.start(q);
        return Models.QuoteSent.Modify;
    };

	// 开启quote订单
    private start = (q: Models.Timestamped<Models.Quote>): Models.QuoteSent => {
        const existing = this._activeQuote;

        const newOrder = new Models.SubmitNewOrder(this._side, q.data.size, Models.OrderType.Limit,
            q.data.price, Models.TimeInForce.GTC, this._exchange, q.time, true, Models.OrderSource.Quote);
        const sent = this._broker.sendOrder(newOrder);

        const quoteOrder = new QuoteOrder(q.data, sent.sentOrderClientId);
        this.quotesSent.push(quoteOrder);
        this._activeQuote = quoteOrder;

        return Models.QuoteSent.First;
    };

	// 停止quote订单
    private stop = (t: Date): Models.QuoteSent => {
        if (this._activeQuote === null) { // quote不存在
            return Models.QuoteSent.UnsentDelete; // 无法取消
        }

        const cxl = new Models.OrderCancel(this._activeQuote.orderId, this._exchange, t);
        this._broker.cancelOrder(cxl);
        this._activeQuote = null;
        return Models.QuoteSent.Delete; // 删除状态
    };
}