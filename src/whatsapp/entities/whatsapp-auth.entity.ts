import { Entity, PrimaryColumn, Column } from 'typeorm';

@Entity('whatsapp_auth')
export class WhatsappAuth {
  @PrimaryColumn('text')
  id: string;

  @Column('text', { nullable: true })
  value: string;
}
