import { BaseBuildParams } from "@reservoir0x/sdk/dist/looks-rare/builders/base";
import axios from "axios";

import { config } from "@/config/index";
import { redb } from "@/common/db";

export interface BaseOrderBuildOptions {
  maker: string;
  contract: string;
  weiPrice: string;
  listingTime?: number;
  expirationTime?: number;
}

type OrderBuildInfo = {
  params: BaseBuildParams;
};

export const getBuildInfo = async (
  options: BaseOrderBuildOptions,
  collection: string,
  side: "sell" | "buy"
): Promise<OrderBuildInfo> => {
  const collectionResult = await redb.oneOrNone(
    `
      SELECT
        1
      FROM collections
      JOIN contracts
        ON collections.contract = contracts.address
      WHERE collections.id = $/collection/
      LIMIT 1
    `,
    { collection }
  );
  if (!collectionResult) {
    // Skip if we cannot retrieve the collection
    throw new Error("Could not fetch token collection");
  }

  const buildParams: BaseBuildParams = {
    isOrderAsk: side === "sell",
    collection: options.contract,
    signer: options.maker,
    price: options.weiPrice,
    // TODO: We should only use LooksRare's nonce when cross-posting to their orderbook
    nonce: await axios
      .get(
        `https://${
          config.chainId === 4 ? "api-rinkeby." : "api."
        }looksrare.org/api/v1/orders/nonce?address=${options.maker}`,
        {
          headers: {
            "Content-Type": "application/json",
            "X-Looks-Api-Key": config.looksRareApiKey,
          },
        }
      )
      .then(({ data }: { data: { data: string } }) => data.data),
    startTime: options.listingTime,
    endTime: options.expirationTime,
  };

  return {
    params: buildParams,
  };
};
