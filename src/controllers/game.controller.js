import { PrismaClient } from '../generated/prisma/index.js';
import { initializeGameData } from '../utils/gameUtils.js';
import { ludoGameLoop } from '../engine/ludoGameLoop.js';
import { broadcastGameState } from '../socket/socketManager.js';
import { whotGameLoop } from '../engine/whotGameLoop.js';

// Prisma client
const prisma = new PrismaClient();

// Create a new game
export const createGame = async (req, res) => {
  try {
    const { gameType } = req.body;
    const userId = req.user.id; // From auth middleware

    const game = await prisma.game.create({
      data: {
        gameType,
        player1Id: userId,
        status: 'WAITING'
      },
      include: {
        player1: {
          select: { id: true, name: true, rating: true }
        }
      }
    });

    res.status(201).json({
      success: true,
      game
    });
  } catch (error) {
    console.error('Create game error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to create game'
    });
  }
};

// Join an existing game
export const joinGame = async (req, res) => {
  try {
    const { gameId } = req.params;
    const userId = req.user.id;

    const game = await prisma.game.findUnique({
      where: { id: gameId },
      include: {
        player1: { select: { id: true, name: true, rating: true } },
        player2: { select: { id: true, name: true, rating: true } }
      }
    });

    if (!game) {
      return res.status(404).json({
        success: false,
        message: 'Game not found'
      });
    }

    if (game.status !== 'WAITING') {
      return res.status(400).json({
        success: false,
        message: 'Game is not available to join'
      });
    }

    if (game.player1Id === userId) {
      return res.status(400).json({
        success: false,
        message: 'Cannot join your own game'
      });
    }

    // Update game with player 2
    const updateData = {
      player2Id: userId,
      status: 'IN_PROGRESS',
      startedAt: new Date(),
    };

    // Initialize state
    if (game.gameType === 'whot') {
      const highestRating = Math.max(game.player1.rating || 0, (req.user.rating || 0));
      const config = {
        gameRankType: highestRating >= 1750 ? 'competitive' : 'casual',
        ruleVersion: highestRating >= 1750 ? 'rule2' : 'rule1'
      };
      const board = await whotGameLoop.initializeMatch(gameId, game.player1, { id: userId, name: req.user.name || 'Opponent' }, config);
      updateData.board = board;
      updateData.currentTurn = board.turnPlayer;
    } else {
      const gameData = initializeGameData(game.gameType, game.player1, { id: userId, name: req.user.name || 'Opponent' });
      Object.assign(updateData, gameData);
    }

    const updatedGame = await prisma.game.update({
      where: { id: gameId },
      data: updateData,
      include: {
        player1: { select: { id: true, name: true, rating: true } },
        player2: { select: { id: true, name: true, rating: true } }
      }
    });

    // START GAME TIMER
    if (game.gameType === 'ludo') {
      ludoGameLoop.startTurnTimer(gameId, updatedGame.player1Id);
    } else if (game.gameType === 'whot') {
      whotGameLoop.startTurnTimer(gameId, updatedGame.currentTurn);
    }

    // Broadcast Join Event
    broadcastGameState(gameId, 'playerJoined', {
      game: updatedGame
    });

    res.json({
      success: true,
      game: updatedGame
    });
  } catch (error) {
    console.error('Join game error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to join game'
    });
  }
};

// Get available games
export const getAvailableGames = async (req, res) => {
  try {
    const games = await prisma.game.findMany({
      where: {
        status: 'WAITING',
        player2Id: null
      },
      include: {
        player1: {
          select: { id: true, name: true, rating: true }
        }
      },
      orderBy: { createdAt: 'desc' }
    });

    res.json({
      success: true,
      games
    });
  } catch (error) {
    console.error('Get available games error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch games'
    });
  }
};

// Get game by ID
export const getGame = async (req, res) => {
  try {
    const { gameId } = req.params;

    const game = await prisma.game.findUnique({
      where: { id: gameId },
      include: {
        player1: { select: { id: true, name: true, rating: true } },
        player2: { select: { id: true, name: true, rating: true } }
      }
    });

    if (!game) {
      return res.status(404).json({
        success: false,
        message: 'Game not found'
      });
    }

    if (game.gameType === 'whot') {
      const userId = req.user.id;
      const snapshot = await whotGameLoop.getFullStateSnapshot(gameId, userId);
      if (snapshot) {
        game.board = snapshot;
      }
    } else if (game.gameType === 'ludo') {
      const snapshot = await ludoGameLoop.getSnapshot(gameId);
      if (snapshot) {
        game.board = snapshot.board;
      }
    }

    res.json({
      success: true,
      game
    });
  } catch (error) {
    console.error('Get game error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch game'
    });
  }
};

// Update game state
export const updateGameState = async (req, res) => {
  try {
    const { gameId } = req.params;
    const { board, currentTurn, winnerId, status } = req.body;
    const userId = req.user.id;

    // Note: Assuming auth middleware populates req.user

    const game = await prisma.game.findUnique({
      where: { id: gameId }
    });

    if (!game) {
      return res.status(404).json({
        success: false,
        message: 'Game not found'
      });
    }

    // Check if user is part of the game
    if (game.player1Id !== userId && game.player2Id !== userId) {
      return res.status(403).json({
        success: false,
        message: 'Not authorized to update this game'
      });
    }

    const updateData = {};
    if (board !== undefined) {
      if (game.gameType === 'whot' || game.gameType === 'ludo') {
        return res.status(400).json({ success: false, message: 'Direct board updates not allowed. Use intent endpoints.' });
      }
      updateData.board = board;
    }
    if (currentTurn !== undefined) {
      if (game.gameType === 'whot' || game.gameType === 'ludo') {
        return res.status(400).json({ success: false, message: 'Direct turn updates not allowed.' });
      }
      updateData.currentTurn = currentTurn;
    }
    if (winnerId !== undefined) updateData.winnerId = winnerId;
    if (status !== undefined) updateData.status = status;

    if (status === 'COMPLETED') {
      updateData.endedAt = new Date();
      // Clear Timer
      if (game.gameType === 'ludo') {
        ludoGameLoop.clearTurnTimer(gameId);
      } else if (game.gameType === 'whot') {
        whotGameLoop.clearTurnTimer(gameId);
      }
    }

    const updatedGame = await prisma.game.update({
      where: { id: gameId },
      data: updateData,
      include: {
        player1: { select: { id: true, name: true, rating: true } },
        player2: { select: { id: true, name: true, rating: true } }
      }
    });

    res.json({
      success: true,
      game: updatedGame
    });
  } catch (error) {
    console.error('Update game state error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update game'
    });
  }
};

/**
 * Server-Authoritative Whot Move
 */
export const playWhotMove = async (req, res) => {
  try {
    const { gameId } = req.params;
    const { move } = req.body; // e.g. { type: 'PLAY_CARD', cardId: '...', calledSuit: '...', moveId: 123 }
    const userId = req.user.id;

    // Atomic Execution via Game Loop (Handles locking, validation, application, and persistence)
    const nextState = await whotGameLoop.executeMove(gameId, userId, move);

    res.json({
      success: true,
      board: whotGameEngine.scrubState(nextState, userId) // Return scrubbed state to player
    });

  } catch (error) {
    console.error('[WhotMove] Error:', error);

    // SECURITY: If move is invalid, force a sync with the authoritative state
    const memState = await whotGameLoop.getMatchState(gameId);
    if (memState) {
      const scrubbed = whotGameEngine.scrubState(memState, userId);
      // We can use broadcastGameState but specifically for this user if we had their socket
      // For now, returning it in the error response is the standard sync path
      return res.status(400).json({
        success: false,
        message: error.message || 'Invalid move',
        forceFullSync: true,
        board: scrubbed
      });
    }

    res.status(400).json({
      success: false,
      message: error.message || 'Failed to process move'
    });
  }
};
