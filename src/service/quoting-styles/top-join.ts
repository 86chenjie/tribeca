/// <reference path="../../common/models.ts" />

import StyleHelpers = require("./helpers");
import Models = require("../../common/models");

export class TopOfTheMarketQuoteStyle implements StyleHelpers.QuoteStyle {
    Mode = Models.QuotingMode.Top;
    
    GenerateQuote = (input: StyleHelpers.QuoteInput) : StyleHelpers.GeneratedQuote => {
        return computeTopJoinQuote(input);
    };
}

export class InverseTopOfTheMarketQuoteStyle implements StyleHelpers.QuoteStyle {
    Mode = Models.QuotingMode.InverseTop;
    
    GenerateQuote = (input: StyleHelpers.QuoteInput) : StyleHelpers.GeneratedQuote => {
        return computeInverseJoinQuote(input);
    };
}

export class InverseJoinQuoteStyle implements StyleHelpers.QuoteStyle {
    Mode = Models.QuotingMode.InverseJoin;
    
    GenerateQuote = (input: StyleHelpers.QuoteInput) : StyleHelpers.GeneratedQuote => {
        return computeInverseJoinQuote(input);
    };
}

export class PingPongQuoteStyle implements StyleHelpers.QuoteStyle {
    Mode = Models.QuotingMode.PingPong;

    GenerateQuote = (input: StyleHelpers.QuoteInput) : StyleHelpers.GeneratedQuote => {
        return computePingPongQuote(input);
    };
}

export class JoinQuoteStyle implements StyleHelpers.QuoteStyle {
    Mode = Models.QuotingMode.Join;
    
    GenerateQuote = (input: StyleHelpers.QuoteInput) : StyleHelpers.GeneratedQuote => {
        return computeTopJoinQuote(input);
    };
}

// 计算当前行情的有效的价格/数量信息
function getQuoteAtTopOfMarket(input: StyleHelpers.QuoteInput): StyleHelpers.GeneratedQuote {
    var topBid = (input.market.bids[0].size > input.params.stepOverSize ? input.market.bids[0] : input.market.bids[1]);
    if (typeof topBid === "undefined") topBid = input.market.bids[0]; // only guaranteed top level exists
    var bidPx = topBid.price;

    var topAsk = (input.market.asks[0].size > input.params.stepOverSize ? input.market.asks[0] : input.market.asks[1]);
    if (typeof topAsk === "undefined") topAsk = input.market.asks[0];
    var askPx = topAsk.price;

    return new StyleHelpers.GeneratedQuote(bidPx, topBid.size, askPx, topAsk.size);
}

// TOP/JOIN区别只是一个小价差
function computeTopJoinQuote(input: StyleHelpers.QuoteInput) {
    var genQt = getQuoteAtTopOfMarket(input);

    // TOP时，买一价加上一个小价差，这样可以排到前面
    if (input.params.mode === Models.QuotingMode.Top && genQt.bidSz > .2) {
        genQt.bidPx += input.minTickIncrement;
    }

    // width>>BBO时，使用 中间价-width/2 作为买价
    // width<<BBO时，使用 买一价
    // 总结，使用尽量低的买价。width理解为，为了避免买卖价太接近，设置的最小值
    var minBid = input.fv.price - input.params.width / 2.0;
    genQt.bidPx = Math.min(minBid, genQt.bidPx);

    if (input.params.mode === Models.QuotingMode.Top && genQt.askSz > .2) {
        genQt.askPx -= input.minTickIncrement;
    }

    var minAsk = input.fv.price + input.params.width / 2.0;
    genQt.askPx = Math.max(minAsk, genQt.askPx);

    genQt.bidSz = input.params.size;
    genQt.askSz = input.params.size;

    return genQt;
}

function computeInverseJoinQuote(input: StyleHelpers.QuoteInput) {
    // 一档买卖价
    var genQt = getQuoteAtTopOfMarket(input);

    var mktWidth = Math.abs(genQt.askPx - genQt.bidPx);
    if (mktWidth > input.params.width) {
        genQt.askPx += input.params.width;
        genQt.bidPx -= input.params.width;
    }

    if (input.params.mode === Models.QuotingMode.InverseTop) {
        if (genQt.bidSz > .2) genQt.bidPx += input.minTickIncrement;
        if (genQt.askSz > .2) genQt.askPx -= input.minTickIncrement;
    }

    if (mktWidth < (2.0 * input.params.width / 3.0)) {
        genQt.askPx += input.params.width / 4.0;
        genQt.bidPx -= input.params.width / 4.0;
    }

    genQt.bidSz = input.params.size;
    genQt.askSz = input.params.size;

    return genQt;
}

//computePingPongQuote is same as computeTopJoinQuote but need to use params.mode === Models.QuotingMode.PingPong 
function computePingPongQuote(input: StyleHelpers.QuoteInput) {
    var genQt = getQuoteAtTopOfMarket(input);

    if (input.params.mode === Models.QuotingMode.PingPong && genQt.bidSz > .2) {
        genQt.bidPx += input.minTickIncrement;
    }

    var minBid = input.fv.price - input.params.width / 2.0;
    genQt.bidPx = Math.min(minBid, genQt.bidPx);

    if (input.params.mode === Models.QuotingMode.PingPong && genQt.askSz > .2) {
        genQt.askPx -= input.minTickIncrement;
    }

    var minAsk = input.fv.price + input.params.width / 2.0;
    genQt.askPx = Math.max(minAsk, genQt.askPx);

    genQt.bidSz = input.params.size;
    genQt.askSz = input.params.size;

    return genQt;
}