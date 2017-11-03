/// <reference path="../../common/models.ts" />

import Models = require("../../common/models");

export class GeneratedQuote {
    constructor(public bidPx: number, public bidSz: number, public askPx: number, public askSz: number) { }
}

export class QuoteInput {
    constructor(
        public market: Models.Market, // 深度行情
        public fv: Models.FairValue, // 真实价格
        public params: Models.QuotingParameters,
        public minTickIncrement: number,
        public minSizeIncrement: number = 0.01) {} // 这个字段从未被使用过
}

export interface QuoteStyle {
    Mode : Models.QuotingMode;
    GenerateQuote(input: QuoteInput) : GeneratedQuote;
}