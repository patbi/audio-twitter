import mongoose from 'mongoose';
import { combineResolvers } from 'graphql-resolvers';

import pubsub, { EVENTS } from '../subscription';
import { isAuthenticated, isMessageOwner } from './authorization';
import { processFile } from '../utils/upload';

// to base64, da klijent aplikacija ne bi radila sa datumom nego sa stringom
const toCursorHash = string => Buffer.from(string).toString('base64');

// from base64
const fromCursorHash = string =>
  Buffer.from(string, 'base64').toString('ascii');

export default {
  Query: {
    // kursor je vazan za vrednost podatka, a ne index elementa kao u offset/limmit paginaciji
    // kad se izbrise iz izvadjenih offset postaje nevalidan, a kursor ostaje uvek isti
    // createdAt za cursor
    messages: async (
      parent,
      { cursor, limit = 100, username },
      { models },
    ) => {
      const user = username
        ? await models.User.findOne({
            username,
          })
        : null;

      const options = {
        // za prvi upit ne treba cursor
        ...(cursor && {
          newCreatedAt: {
            $lt: fromCursorHash(cursor),
          },
        }),
        ...(username && {
          userId: mongoose.Types.ObjectId(user.id),
        }),
      };

      /*
      const messages1 = await models.Message.find(options, null, {
        sort: { createdAt: -1 }, //-1 smer sortiranja, cursor mora da bude sortiran
        limit: limit + 1,
      });
      */

      //console.log(options);

      const aMessages = await models.Message.aggregate([
        { $match: options },
        {
          $addFields: {
            newReposts: {
              $concatArrays: [
                [{ createdAt: '$createdAt', original: true }],
                '$reposts',
              ],
            },
          },
        },
        {
          $unwind: '$newReposts', //pomnozi polje
        },
        {
          $addFields: {
            newCreatedAt: '$newReposts.createdAt',
            original: '$newReposts.original',
          },
        },
        {
          $sort: {
            newCreatedAt: -1,
          },
        },
        {
          $limit: limit + 1,
        },
      ]);
      console.log(aMessages);

      //const messages1 = aMessages.map(m => new models.Message(m));//da ne kreira nove datume
      const messages = aMessages.map(m => {
        m.id = m._id.toString();
        return m;
      });

      const hasNextPage = messages.length > limit;
      const edges = hasNextPage ? messages.slice(0, -1) : messages; //-1 exclude zadnji
      //console.log(edges[edges.length - 1].createdAt.toString());

      return {
        edges,
        pageInfo: {
          hasNextPage,
          endCursor: toCursorHash(
            edges[edges.length - 1].createdAt.toString(),
          ),
        },
      };
    },
    message: async (parent, { id }, { models }) => {
      return await models.Message.findById(id);
    },
  },

  Mutation: {
    // combine middlewares
    createMessage: combineResolvers(
      // resolver middleware
      isAuthenticated,
      // obican resolver
      async (parent, { file }, { models, me }) => {
        const fileSaved = await processFile(file);

        // mora create a ne constructor za timestamps
        const message = await models.Message.create({
          fileId: fileSaved.id,
          userId: me.id,
        });
        pubsub.publish(EVENTS.MESSAGE.CREATED, {
          messageCreated: { message },
        });

        return message;
      },
    ),

    deleteMessage: combineResolvers(
      isAuthenticated,
      isMessageOwner,
      async (parent, { id }, { models }) => {
        const message = await models.Message.findById(id);

        if (message) {
          await message.remove();
          return true;
        } else {
          return false;
        }
      },
    ),

    likeMessage: combineResolvers(
      isAuthenticated,
      async (parent, { messageId }, { models, me }) => {
        const likedMessage = await models.Message.findOneAndUpdate(
          { _id: messageId },
          { $push: { likesIds: me.id } },
        );
        return !!likedMessage;
      },
    ),
    unlikeMessage: combineResolvers(
      isAuthenticated,
      async (parent, { messageId }, { models, me }) => {
        const unlikedMessage = await models.Message.findOneAndUpdate(
          { _id: messageId },
          { $pull: { likesIds: me.id } },
        );
        return !!unlikedMessage;
      },
    ),
    repostMessage: combineResolvers(
      isAuthenticated,
      async (parent, { messageId }, { models, me }) => {
        const repostedMessage = await models.Message.findOneAndUpdate(
          { _id: messageId },
          { $push: { reposts: { reposterId: me.id } } },
          { new: true },
        );
        return !!repostedMessage;
      },
    ),
    unrepostMessage: combineResolvers(
      isAuthenticated,
      async (parent, { messageId }, { models, me }) => {
        const unrepostedMessage = await models.Message.findOneAndUpdate(
          { _id: messageId },
          { $pull: { reposts: { reposterId: me.id } } },
        );
        return !!unrepostedMessage;
      },
    ),
  },

  Message: {
    user: async (message, args, { loaders }) => {
      // loaders iz contexta koji je prosledjen
      return await loaders.user.load(message.userId);
    },
    file: async (message, args, { loaders }) => {
      return await loaders.file.load(message.fileId);
    },
    likesCount: async (message, args, { models }) => {
      const likedMessage = await models.Message.findById(message.id);
      return likedMessage.likesIds?.length || 0;
    },
    isLiked: async (message, args, { models, me }) => {
      if (!me) return false;
      const likedMessage = await models.Message.findById(message.id);
      return likedMessage.likesIds?.includes(me.id) || false;
    },
    repostsCount: async (message, args, { models }) => {
      const rpMessage = await models.Message.findById(message.id);
      return rpMessage.reposts?.length || 0;
    },
    isReposted: async (message, args, { models, me }) => {
      if (!me) return false;
      const rpMessage = await models.Message.findById(message.id);
      const repost = rpMessage.reposts?.find(r =>
        r.reposterId.equals(me.id),
      );
      return !!repost;
    },
  },

  Subscription: {
    messageCreated: {
      subscribe: () => pubsub.asyncIterator(EVENTS.MESSAGE.CREATED),
    },
  },
};
