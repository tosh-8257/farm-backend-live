import { WebSocketGateway, WebSocketServer, SubscribeMessage, OnGatewayConnection, OnGatewayDisconnect, MessageBody, ConnectedSocket } from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';

@WebSocketGateway({
  cors: {
    origin: (origin, callback) => {
      if (!origin) {
        return callback(null, true);
      }

      // Flutter web's development server selects an available port at startup.
      const localhostCorsRegex = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;
      const allowedOrigins = (process.env.CORS_ORIGINS ?? '')
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean);
      const isAllowed = allowedOrigins.some((allowedOrigin) => {
        if (allowedOrigin === origin) return true;
        if (!allowedOrigin.includes('*')) return false;

        const escaped = allowedOrigin.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
        return new RegExp(`^${escaped.replace(/\\\*/g, '.*')}$`).test(origin);
      });

      const allowLocalhost = process.env.NODE_ENV !== 'production';
      return callback(null, isAllowed || (allowLocalhost && localhostCorsRegex.test(origin)));
    },
  },
  namespace: '/ws',
})
export class WebsocketGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer() server!: Server;
  private readonly logger = new Logger(WebsocketGateway.name);
  private userSockets = new Map<string, string>(); // userId → socketId

  constructor(private jwtService: JwtService, private cfg: ConfigService) {}

  handleConnection(client: Socket) {
    this.logger.debug(`Client connected: ${client.id}`);
  }

  handleDisconnect(client: Socket) {
    for (const [userId, socketId] of this.userSockets.entries()) {
      if (socketId === client.id) { this.userSockets.delete(userId); break; }
    }
    this.logger.debug(`Client disconnected: ${client.id}`);
  }

  @SubscribeMessage('identify')
  async handleIdentify(
    @MessageBody() data: { token: string },
    @ConnectedSocket() client: Socket,
  ) {
    try {
      const payload = this.jwtService.verify(data.token, {
        secret: this.cfg.get('JWT_ACCESS_SECRET'),
      });
      const userId = payload.sub;
      this.userSockets.set(userId, client.id);
      client.join(`user:${userId}`);
      return { event: 'identified', data: { user_id: userId } };
    } catch (error) {
      this.logger.warn(`WebSocket identify failed: ${error}`);
      client.disconnect(true);
      return { event: 'error', data: { message: 'Unauthorized' } };
    }
  }

  emitToUser(userId: string, event: string, data: any) {
    this.server.to(`user:${userId}`).emit(event, data);
  }

  emitTransactionUpdate(userId: string, transaction: any) {
    this.emitToUser(userId, 'transaction:update', transaction);
  }

  emitEscrowUpdate(userId: string, escrow: any) {
    this.emitToUser(userId, 'escrow:update', escrow);
  }

  emitBalanceUpdate(userId: string, balance: number) {
    this.emitToUser(userId, 'balance:update', { balance });
  }
}