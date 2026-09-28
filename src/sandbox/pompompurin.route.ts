import { FastifyPluginAsync } from "fastify";
import { Type } from "@sinclair/typebox";

const PompompurinResponse = Type.Object({
  message: Type.Literal("Yes"),
  from: Type.Literal("musing_jm"),
  timestamp: Type.String({ format: "date-time" }),
});

export const sandboxRoutes: FastifyPluginAsync = async (app) => {
  app.get("/pompompurin", {
    schema: {
      tags: ["sandbox"],
      summary: "과제용 sandbox 엔드포인트",
      response: { 200: PompompurinResponse },
    },
  }, async () => {
    return {
      message: "Yes" as const,
      from: "musing_jm" as const,
      timestamp: new Date().toISOString(),
    };
  });
};
