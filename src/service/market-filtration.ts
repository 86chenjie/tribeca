/// <reference path="../common/models.ts" />
/// <reference path="../common/messaging.ts" />
/// <reference path="config.ts" />
/// <reference path="utils.ts" />
/// <reference path="quoter.ts"/>
/// <reference path="interfaces.ts"/>

import Config = require("./config");
import Models = require("../common/models");
import Messaging = require("../common/messaging");
import Utils = require("./utils");
import Interfaces = require("./interfaces");
import Quoter = require("./quoter");
import _ = require("lodash");

// 深度行情过滤，保存过滤后的最新多档行情
export class MarketFiltration {
    private _latest: Models.Market = null; // 深度行情信息
    public FilteredMarketChanged = new Utils.Evt<Models.Market>();

    public get latestFilteredMarket() { return this._latest; }
    public set latestFilteredMarket(val: Models.Market) {
        this._latest = val;
        this.FilteredMarketChanged.trigger();
    }

    constructor(
        private _details: Interfaces.IBroker,
        private _scheduler: Utils.IActionScheduler,
        private _quoter: Quoter.Quoter, // quote管理
        private _broker: Interfaces.IMarketDataBroker) {
            _broker.MarketData.on(() => this._scheduler.schedule(this.filterFullMarket));
    }

	// 接收到深度信息后调用
    private filterFullMarket = () => {
        var mkt = this._broker.currentBook;

        if (mkt == null || mkt.bids.length < 1 || mkt.asks.length < 1) {
            this.latestFilteredMarket = null;
            return;
        }

		// 过滤买卖档行情/修正下单量
        var ask = this.filterMarket(mkt.asks, Models.Side.Ask);
        var bid = this.filterMarket(mkt.bids, Models.Side.Bid);

        this.latestFilteredMarket = new Models.Market(bid, ask, mkt.time);
    };

    private filterMarket = (mkts: Models.MarketSide[], s: Models.Side): Models.MarketSide[]=> {
        var rgq = this._quoter.quotesSent(s); // 某个买卖方向上的quote列表

        var copiedMkts = [];
        for (var i = 0; i < mkts.length; i++) { // 某个买卖方向上的多档行情
            copiedMkts.push(new Models.MarketSide(mkts[i].price, mkts[i].size))
        }

        for (var j = 0; j < rgq.length; j++) { // 遍历quote列表
            var q = rgq[j].quote;

            for (var i = 0; i < copiedMkts.length; i++) { // 遍历多档行情
                var m = copiedMkts[i];

				// quote订单的下单价格/行情价格 价差很小
                if (Math.abs(q.price - m.price) < this._details.minTickIncrement) {
                    copiedMkts[i].size = m.size - q.size; // 行情的下单量减去quote订单的下单量：自己下的订单在该档行情中
                }
            }
        }

		// 只选出量比较大的档位行情
        return copiedMkts.filter(m => m.size > 0.001);
    };
}