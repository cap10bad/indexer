/* eslint-disable @typescript-eslint/no-explicit-any */

import { AddressZero } from "@ethersproject/constants";
import * as Boom from "@hapi/boom";
import { Request, RouteOptions } from "@hapi/hapi";
import * as Sdk from "@reservoir0x/sdk";
import { TxData } from "@reservoir0x/sdk/dist/utils";
import Joi from "joi";
import _ from "lodash";

import { logger } from "@/common/logger";
import { slowProvider } from "@/common/provider";
import { config } from "@/config/index";
import * as commonHelpers from "@/orderbook/orders/common/helpers";

// LooksRare
import * as looksRareSellToken from "@/orderbook/orders/looks-rare/build/sell/token";
import * as looksRareCheck from "@/orderbook/orders/looks-rare/check";

// OpenDao
import * as openDaoSellToken from "@/orderbook/orders/opendao/build/sell/token";
import * as openDaoCheck from "@/orderbook/orders/opendao/check";

// Seaport
import * as seaportSellToken from "@/orderbook/orders/seaport/build/sell/token";
import * as seaportCheck from "@/orderbook/orders/seaport/check";

// ZeroExV4
import * as zeroExV4SellToken from "@/orderbook/orders/zeroex-v4/build/sell/token";
import * as zeroExV4Check from "@/orderbook/orders/zeroex-v4/check";

// Wyvern v2.3
import * as wyvernV23SellToken from "@/orderbook/orders/wyvern-v2.3/build/sell/token";
import * as wyvernV23Utils from "@/orderbook/orders/wyvern-v2.3/utils";
import * as wyvernV23Check from "@/orderbook/orders/wyvern-v2.3/check";

const version = "v3";

export const getExecuteListV3Options: RouteOptions = {
  description: "Create ask (listing)",
  notes: "Generate a listing and submit it to multiple marketplaces",
  tags: ["api", "x-deprecated"],
  plugins: {
    "hapi-swagger": {
      order: 1,
      deprecated: true,
    },
  },
  validate: {
    payload: Joi.object({
      maker: Joi.string()
        .lowercase()
        .pattern(/^0x[a-fA-F0-9]{40}$/)
        .required()
        .description(
          "Address of wallet making the order. Example: `0xF296178d553C8Ec21A2fBD2c5dDa8CA9ac905A00`"
        ),
      source: Joi.string().description(
        "Name of the platform that created the order. Example: `Chimpers Market`"
      ),
      params: Joi.array().items(
        Joi.object({
          token: Joi.string()
            .lowercase()
            .pattern(/^0x[a-fA-F0-9]{40}:[0-9]+$/)
            .required()
            .description(
              "Filter to a particular token. Example: `0x8d04a8c79ceb0889bdd12acdf3fa9d207ed3ff63:123`"
            ),
          quantity: Joi.number().description(
            "Quanity of tokens user is listing. Only compatible with ERC1155 tokens. Example: `5`"
          ),
          weiPrice: Joi.string()
            .pattern(/^\d+$/)
            .required()
            .description(
              "Amount seller is willing to sell for in wei. Example: `1000000000000000000`"
            ),
          orderKind: Joi.string()
            .valid("721ex", "looks-rare", "wyvern-v2.3", "zeroex-v4", "seaport")
            .default("wyvern-v2.3")
            .description("Exchange protocol used to create order. Example: `seaport`"),
          orderbook: Joi.string()
            .valid("opensea", "looks-rare", "reservoir")
            .default("reservoir")
            .description("Orderbook where order is placed. Example: `Reservoir`"),
          automatedRoyalties: Joi.boolean()
            .default(true)
            .description("If true, royalties will be automatically included."),
          fee: Joi.alternatives(
            Joi.string().pattern(/^\d+$/),
            Joi.number(),
            Joi.array().items(Joi.string().pattern(/^\d+$/)),
            Joi.array().items(Joi.number()).description("Fee amount in BPS. Example: `100`")
          ),
          feeRecipient: Joi.alternatives(
            Joi.string()
              .lowercase()
              .pattern(/^0x[a-fA-F0-9]{40}$/)
              .disallow(AddressZero),
            Joi.array()
              .items(
                Joi.string()
                  .lowercase()
                  .pattern(/^0x[a-fA-F0-9]{40}$/)
                  .disallow(AddressZero)
              )
              .description(
                "Wallet address of fee recipient. Example: `0xF296178d553C8Ec21A2fBD2c5dDa8CA9ac905A00`"
              )
          ),
          listingTime: Joi.alternatives(Joi.string().pattern(/^\d+$/), Joi.number()).description(
            "Unix timestamp indicating when listing will be listed. Example: `1656080318`"
          ),
          expirationTime: Joi.alternatives(Joi.string().pattern(/^\d+$/), Joi.number()).description(
            "Unix timestamp indicating when listing will expire. Example: `1656080318`"
          ),
          salt: Joi.string()
            .pattern(/^\d+$/)
            .description("Optional. Random string to make the order unique"),
          nonce: Joi.string().pattern(/^\d+$/).description("Optional. Set a custom nonce"),
        })
          .with("feeRecipient", "fee")
          .with("fee", "feeRecipient")
      ),
    }),
  },
  response: {
    schema: Joi.object({
      steps: Joi.array().items(
        Joi.object({
          kind: Joi.string().valid("request", "signature", "transaction").required(),
          action: Joi.string().required(),
          description: Joi.string().required(),
          items: Joi.array()
            .items(
              Joi.object({
                status: Joi.string().valid("complete", "incomplete").required(),
                data: Joi.object(),
                orderIndex: Joi.number(),
              })
            )
            .required(),
        })
      ),
    }).label(`getExecuteList${version.toUpperCase()}Response`),
    failAction: (_request, _h, error) => {
      logger.error(`get-execute-list-${version}-handler`, `Wrong response schema: ${error}`);
      throw error;
    },
  },
  handler: async (request: Request) => {
    const payload = request.payload as any;

    try {
      const maker = payload.maker;
      const source = payload.source;

      // Set up generic listing steps
      const steps: {
        action: string;
        description: string;
        kind: string;
        items: {
          status: string;
          data?: any;
          orderIndex?: number;
        }[];
      }[] = [
        {
          action: "Initialize wallet",
          description:
            "A one-time setup transaction to enable trading with the Wyvern Protocol (used by Open Sea)",
          kind: "transaction",
          items: [],
        },
        {
          action: "Approve NFT contract",
          description:
            "Each NFT collection you want to trade requires a one-time approval transaction",
          kind: "transaction",
          items: [],
        },
        {
          action: "Authorize listing",
          description: "A free off-chain signature to create the listing",
          kind: "signature",
          items: [],
        },
      ];

      for (let i = 0; i < payload.params.length; i++) {
        const params = payload.params[i];
        const [contract, tokenId] = params.token.split(":");

        // On Rinkeby, proxy ZeroEx V4 to 721ex
        if (params.orderKind === "zeroex-v4" && config.chainId === 4) {
          params.orderKind = "721ex";
        }

        switch (params.orderKind) {
          case "wyvern-v2.3": {
            // Exchange-specific checks
            if (!["reservoir", "opensea"].includes(params.orderbook)) {
              throw Boom.badRequest("Unsupported orderbook");
            }
            if (params.automatedRoyalties && params.feeRecipient) {
              throw Boom.badRequest("Exchange does not supported multiple fee recipients");
            }
            if (Array.isArray(params.fee) || Array.isArray(params.feeRecipient)) {
              throw Boom.badRequest("Exchange does not support multiple fee recipients");
            }

            const order = await wyvernV23SellToken.build({
              ...params,
              maker,
              contract,
              tokenId,
            });

            // Make sure the order was successfully generated
            const orderInfo = order?.getInfo();
            if (!order || !orderInfo) {
              throw Boom.internal("Failed to generate order");
            }

            // Will be set if an approval is needed before listing
            let approvalTx: TxData | undefined;

            // Check the order's fillability
            try {
              await wyvernV23Check.offChainCheck(order, { onChainApprovalRecheck: true });
            } catch (error: any) {
              switch (error.message) {
                case "no-balance-no-approval":
                case "no-balance": {
                  // We cannot do anything if the user doesn't own the listed token
                  throw Boom.badData("Maker does not own the listed token");
                }

                case "no-user-proxy": {
                  // Generate a proxy registration transaction

                  const proxyRegistry = new Sdk.WyvernV23.Helpers.ProxyRegistry(
                    slowProvider,
                    config.chainId
                  );
                  const proxyRegistrationTx = proxyRegistry.registerProxyTransaction(maker);

                  // Register the steps
                  steps[0].items.push({
                    status: "incomplete",
                    data: proxyRegistrationTx,
                    orderIndex: i,
                  });
                  steps[1].items.push({
                    status: "incomplete",
                    orderIndex: i,
                  });
                  steps[2].items.push({
                    status: "incomplete",
                    orderIndex: i,
                  });

                  // Go on with the next listing
                  continue;
                }

                case "no-approval": {
                  // Generate an approval transaction
                  const userProxy = await wyvernV23Utils.getUserProxy(maker);
                  const kind = order.params.kind?.startsWith("erc721") ? "erc721" : "erc1155";
                  approvalTx = (
                    kind === "erc721"
                      ? new Sdk.Common.Helpers.Erc721(slowProvider, orderInfo.contract)
                      : new Sdk.Common.Helpers.Erc1155(slowProvider, orderInfo.contract)
                  ).approveTransaction(maker, userProxy!);
                }
              }
            }

            steps[0].items.push({
              status: "complete",
              orderIndex: i,
            });
            steps[1].items.push({
              status: !approvalTx ? "complete" : "incomplete",
              data: !approvalTx ? undefined : approvalTx,
              orderIndex: i,
            });
            steps[2].items.push({
              status: "incomplete",
              data: {
                sign: order.getSignatureData(),
                post: {
                  endpoint: "/order/v2",
                  method: "POST",
                  body: {
                    order: {
                      kind: "wyvern-v2.3",
                      data: {
                        ...order.params,
                      },
                    },
                    orderbook: params.orderbook,
                    source,
                  },
                },
              },
              orderIndex: i,
            });

            // Go on with the next listing
            continue;
          }

          case "721ex": {
            // Exchange-specific checks
            if (!["reservoir"].includes(params.orderbook)) {
              throw Boom.badRequest("Unsupported orderbook");
            }

            // Make sure the fee information is correctly typed
            if (params.fee && !Array.isArray(params.fee)) {
              params.fee = [params.fee];
            }
            if (params.feeRecipient && !Array.isArray(params.feeRecipient)) {
              params.feeRecipient = [params.feeRecipient];
            }
            if (params.fee?.length !== params.feeRecipient?.length) {
              throw Boom.badRequest("Invalid fee information");
            }

            const order = await openDaoSellToken.build({
              ...params,
              maker,
              contract,
              tokenId,
            });
            if (!order) {
              throw Boom.internal("Failed to generate order");
            }

            // Will be set if an approval is needed before listing
            let approvalTx: TxData | undefined;

            // Check the order's fillability
            try {
              await openDaoCheck.offChainCheck(order, { onChainApprovalRecheck: true });
            } catch (error: any) {
              switch (error.message) {
                case "no-balance-no-approval":
                case "no-balance": {
                  // We cannot do anything if the user doesn't own the listed token
                  throw Boom.badData("Maker does not own the listed token");
                }

                case "no-approval": {
                  // Generate an approval transaction
                  const kind = order.params.kind?.startsWith("erc721") ? "erc721" : "erc1155";
                  approvalTx = (
                    kind === "erc721"
                      ? new Sdk.Common.Helpers.Erc721(slowProvider, order.params.nft)
                      : new Sdk.Common.Helpers.Erc1155(slowProvider, order.params.nft)
                  ).approveTransaction(maker, Sdk.OpenDao.Addresses.Exchange[config.chainId]);

                  break;
                }
              }
            }

            steps[1].items.push({
              status: approvalTx ? "incomplete" : "complete",
              data: approvalTx,
              orderIndex: i,
            });
            steps[2].items.push({
              status: "incomplete",
              data: {
                sign: order.getSignatureData(),
                post: {
                  endpoint: "/order/v2",
                  method: "POST",
                  body: {
                    order: {
                      kind: "721ex",
                      data: {
                        ...order.params,
                      },
                    },
                    orderbook: params.orderbook,
                    source,
                  },
                },
              },
              orderIndex: i,
            });

            // Go on with the next listing
            continue;
          }

          case "zeroex-v4": {
            // Exchange-specific checks
            if (!["reservoir"].includes(params.orderbook)) {
              throw Boom.badRequest("Unsupported orderbook");
            }

            // Make sure the fee information is correctly typed
            if (params.fee && !Array.isArray(params.fee)) {
              params.fee = [params.fee];
            }
            if (params.feeRecipient && !Array.isArray(params.feeRecipient)) {
              params.feeRecipient = [params.feeRecipient];
            }
            if (params.fee?.length !== params.feeRecipient?.length) {
              throw Boom.badRequest("Invalid fee information");
            }

            const order = await zeroExV4SellToken.build({
              ...params,
              maker,
              contract,
              tokenId,
            });
            if (!order) {
              throw Boom.internal("Failed to generate order");
            }

            // Will be set if an approval is needed before listing
            let approvalTx: TxData | undefined;

            // Check the order's fillability.
            try {
              await zeroExV4Check.offChainCheck(order, { onChainApprovalRecheck: true });
            } catch (error: any) {
              switch (error.message) {
                case "no-balance-no-approval":
                case "no-balance": {
                  // We cannot do anything if the user doesn't own the listed token
                  throw Boom.badData("Maker does not own the listed token");
                }

                case "no-approval": {
                  // Generate an approval transaction
                  const kind = order.params.kind?.startsWith("erc721") ? "erc721" : "erc1155";
                  approvalTx = (
                    kind === "erc721"
                      ? new Sdk.Common.Helpers.Erc721(slowProvider, order.params.nft)
                      : new Sdk.Common.Helpers.Erc1155(slowProvider, order.params.nft)
                  ).approveTransaction(maker, Sdk.ZeroExV4.Addresses.Exchange[config.chainId]);

                  break;
                }
              }
            }

            steps[1].items.push({
              status: approvalTx ? "incomplete" : "complete",
              data: approvalTx,
              orderIndex: i,
            });
            steps[2].items.push({
              status: "incomplete",
              data: {
                sign: order.getSignatureData(),
                post: {
                  endpoint: "/order/v2",
                  method: "POST",
                  body: {
                    order: {
                      kind: "zeroex-v4",
                      data: {
                        ...order.params,
                      },
                    },
                    orderbook: params.orderbook,
                    source,
                  },
                },
              },
              orderIndex: i,
            });

            // Go on with the next listing
            continue;
          }

          case "seaport": {
            // Exchange-specific checks
            if (!["reservoir", "opensea"].includes(params.orderbook)) {
              throw Boom.badRequest("Unsupported orderbook");
            }

            // Make sure the fee information is correctly typed
            if (params.fee && !Array.isArray(params.fee)) {
              params.fee = [params.fee];
            }
            if (params.feeRecipient && !Array.isArray(params.feeRecipient)) {
              params.feeRecipient = [params.feeRecipient];
            }
            if (params.fee?.length !== params.feeRecipient?.length) {
              throw Boom.badRequest("Invalid fee information");
            }

            const order = await seaportSellToken.build({
              ...params,
              maker,
              contract,
              tokenId,
            });
            if (!order) {
              throw Boom.internal("Failed to generate order");
            }

            // Will be set if an approval is needed before listing
            let approvalTx: TxData | undefined;

            // Check the order's fillability
            try {
              await seaportCheck.offChainCheck(order, { onChainApprovalRecheck: true });
            } catch (error: any) {
              switch (error.message) {
                case "no-balance-no-approval":
                case "no-balance": {
                  // We cannot do anything if the user doesn't own the listed token
                  throw Boom.badData("Maker does not own the listed token");
                }

                case "no-approval": {
                  // Generate an approval transaction

                  const exchange = new Sdk.Seaport.Exchange(config.chainId);
                  const info = order.getInfo()!;

                  const kind = order.params.kind?.startsWith("erc721") ? "erc721" : "erc1155";
                  approvalTx = (
                    kind === "erc721"
                      ? new Sdk.Common.Helpers.Erc721(slowProvider, info.contract)
                      : new Sdk.Common.Helpers.Erc1155(slowProvider, info.contract)
                  ).approveTransaction(maker, exchange.deriveConduit(order.params.conduitKey));

                  break;
                }
              }
            }

            steps[1].items.push({
              status: approvalTx ? "incomplete" : "complete",
              data: approvalTx,
              orderIndex: i,
            });
            steps[2].items.push({
              status: "incomplete",
              data: {
                sign: order.getSignatureData(),
                post: {
                  endpoint: "/order/v2",
                  method: "POST",
                  body: {
                    order: {
                      kind: "seaport",
                      data: {
                        ...order.params,
                      },
                    },
                    orderbook: params.orderbook,
                    source,
                  },
                },
              },
              orderIndex: i,
            });

            // Go on with the next listing
            continue;
          }

          case "looks-rare": {
            // Exchange-specific checks
            if (!["reservoir", "looks-rare"].includes(params.orderbook)) {
              throw Boom.badRequest("Unsupported orderbook");
            }
            if (params.fee) {
              throw Boom.badRequest("Exchange does not supported a custom fee");
            }

            const order = await looksRareSellToken.build({
              ...params,
              maker,
              contract,
              tokenId,
            });
            if (!order) {
              throw Boom.internal("Failed to generate order");
            }

            // Will be set if an approval is needed before listing
            let approvalTx: TxData | undefined;

            // Check the order's fillability
            try {
              await looksRareCheck.offChainCheck(order, { onChainApprovalRecheck: true });
            } catch (error: any) {
              switch (error.message) {
                case "no-balance-no-approval":
                case "no-balance": {
                  // We cannot do anything if the user doesn't own the listed token
                  throw Boom.badData("Maker does not own the listed token");
                }

                case "no-approval": {
                  const contractKind = await commonHelpers.getContractKind(contract);
                  if (!contractKind) {
                    throw Boom.internal("Missing contract kind");
                  }

                  // Generate an approval transaction
                  approvalTx = (
                    contractKind === "erc721"
                      ? new Sdk.Common.Helpers.Erc721(slowProvider, order.params.collection)
                      : new Sdk.Common.Helpers.Erc1155(slowProvider, order.params.collection)
                  ).approveTransaction(
                    maker,
                    contractKind === "erc721"
                      ? Sdk.LooksRare.Addresses.TransferManagerErc721[config.chainId]
                      : Sdk.LooksRare.Addresses.TransferManagerErc1155[config.chainId]
                  );

                  break;
                }
              }
            }

            steps[1].items.push({
              status: approvalTx ? "incomplete" : "complete",
              data: approvalTx,
              orderIndex: i,
            });
            steps[2].items.push({
              status: "incomplete",
              data: {
                sign: order.getSignatureData(),
                post: {
                  endpoint: "/order/v2",
                  method: "POST",
                  body: {
                    order: {
                      kind: "looks-rare",
                      data: {
                        ...order.params,
                      },
                    },
                    orderbook: params.orderbook,
                    source,
                  },
                },
              },
              orderIndex: i,
            });

            // Go on with the next listing
            continue;
          }
        }
      }

      // De-duplicate step items
      for (const step of steps) {
        // Assume `JSON.stringify` is deterministic
        const uniqueItems = _.uniqBy(step.items, ({ data }) => JSON.stringify(data));
        if (step.items.length > uniqueItems.length) {
          step.items = uniqueItems.map((item) => ({ status: item.status, data: item.data }));
        }
      }

      return { steps };
    } catch (error) {
      logger.error(`get-execute-list-${version}-handler`, `Handler failure: ${error}`);
      throw error;
    }
  },
};
