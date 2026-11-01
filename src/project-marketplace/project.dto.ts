import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsUUID,
  ValidateNested,
  IsBoolean,
  IsIn,
  IsInt,
  IsISO8601,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';
import {
  DOCUMENT_KINDS,
  DOCUMENT_VISIBILITY,
  INSTRUMENT_TYPES,
  SECTORS,
} from './project-rules';

export class ProjectInputDto {
  @IsOptional() @IsString() @Length(3, 255) project_name?: string;
  @IsOptional() @IsIn(SECTORS) sector?: string;
  @IsOptional() @IsString() @MaxLength(500) summary?: string;
  @IsOptional() @IsString() @MaxLength(20000) description?: string;
  @IsOptional() @IsString() @MaxLength(255) location?: string;
  @IsOptional() @Matches(/^[A-Z]{2}$/) country?: string;
  @IsOptional() @IsString() @MaxLength(2000) banner_image?: string;
  @IsOptional() @IsNumber() @IsPositive() target_amount?: number;
  @IsOptional() @IsNumber() @IsPositive() minimum_investment?: number;
  @IsOptional()
  @ValidateIf((o) => o.maximum_investment !== null)
  @IsNumber()
  @IsPositive()
  maximum_investment?: number | null;
  @IsOptional()
  @IsIn(INSTRUMENT_TYPES)
  instrument_type?: string;
  @IsOptional() @IsInt() @Min(1) @Max(360) duration_months?: number;
  @IsOptional() @IsString() @MaxLength(20000) use_of_funds?: string;
  @IsOptional() @IsString() @MaxLength(20000) risk_factors?: string;
  @IsOptional() @IsString() @MaxLength(20000) team?: string;
  @IsOptional()
  @ValidateIf((o) => o.starts_at !== null)
  @IsISO8601()
  starts_at?: string | null;
  @IsOptional() @ValidateIf((o) => o.ends_at !== null) @IsISO8601() ends_at?:
    | string
    | null;
}

export class ProjectDocumentDto {
  @IsIn(DOCUMENT_KINDS) kind!: string;
  @IsString() @Length(1, 255) title!: string;
  @IsString() @Matches(/^https:\/\/\S+$/) @MaxLength(2000) url!: string;
  @IsOptional()
  @IsIn(DOCUMENT_VISIBILITY)
  visibility?: string;
}

export class ProjectUpdateDto {
  @IsString() @Length(1, 255) title!: string;
  @IsString() @Length(1, 20000) body!: string;
}

export class MarketplaceInvestDto {
  @IsNumber() @IsPositive() amount!: number;
  @IsNotEmpty() @IsString() @Length(4, 6) pin!: string;
  @IsBoolean() accept_risk!: boolean;
  @IsString() @Length(1, 20) disclosure_version!: string;
}

export class ReviewActionDto {
  @IsIn([
    'request_info',
    'approve',
    'reject',
    'list',
    'unlist',
    'close',
    'cancel',
  ])
  action!: string;
  @IsOptional() @IsString() @MaxLength(5000) notes?: string;
}

export class EligibilityDto {
  @IsIn(['pending', 'eligible', 'restricted']) status!: string;
  @IsOptional()
  @IsIn(['retail', 'sophisticated', 'institutional'])
  category?: string;
  @IsOptional() @IsString() @MaxLength(2000) notes?: string;
}

export class MilestoneItemDto {
  @IsString() @Length(1, 255) title!: string;
  @IsOptional() @IsString() @MaxLength(5000) description?: string;
  @IsNumber() @IsPositive() amount!: number;
}
export class MilestonePlanDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(12)
  @ValidateNested({ each: true })
  @Type(() => MilestoneItemDto)
  milestones!: MilestoneItemDto[];
}
export class MilestoneRequestDto {
  @IsString() @Length(1, 5000) evidence!: string;
  @IsOptional()
  @IsString()
  @Matches(/^https:\/\/\S+$/)
  @MaxLength(2000)
  evidence_url?: string;
}
export class MilestoneNotesDto {
  @IsOptional() @IsString() @MaxLength(5000) notes?: string;
}

export class FundsSettingsDto {
  @IsIn(['off', 'monthly', 'on_deposit', 'period_end'])
  distribution_mode!: string;
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(100)
  distribution_percent!: number;
  @IsOptional() @IsDateString() distribution_period_end?: string;
  @IsOptional() @IsIn(['profit', 'rental']) income_kind?: string;
}
export class ReturnDepositDto {
  @IsNumber({ maxDecimalPlaces: 2 }) @Min(1) amount!: number;
  @IsOptional() @IsUUID() transaction_id?: string;
  @IsOptional() @IsString() @MaxLength(500) note?: string;
  @IsString() @Length(4, 12) pin!: string;
}
export class ProjectSpendDto {
  @IsIn(['invoice', 'payment_link']) kind!: string;
  /** Invoice number or payment link code. */
  @IsString() @Length(1, 100) ref!: string;
  @IsString() @Length(4, 12) pin!: string;
  /** Optional deliverable tag, e.g. "Greenhouse kit". */
  @IsOptional() @IsString() @MaxLength(120) tag?: string;
  @IsOptional() @IsString() @MaxLength(500) note?: string;
  /** Client retry key; the same key never pays twice. */
  @IsOptional() @IsString() @Length(8, 80) idempotency_key?: string;
}
export class FundsPauseDto {
  @IsBoolean() paused!: boolean;
  @IsOptional() @IsString() @MaxLength(300) reason?: string;
}
